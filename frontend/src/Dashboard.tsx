import { useEffect, useState, Suspense, lazy, useMemo, useCallback } from "react";
import {
  Activity,
  Users,
  Building2,
  LayoutGrid,
  ScrollText,
  LogOut,
  Plug,
  Lock,
  Puzzle,
  ToggleLeft,
  Shield,
  Workflow,
  CreditCard,
  Settings,
  Code2,
  BookOpen,
  Monitor,
  UserCircle,
  Sun,
  Moon,
  Webhook,
  ShieldCheck,
  Layers,
  BarChart3,
} from "lucide-react";
import { api } from "./api.ts";
import { Button } from "./components/ui/Button.tsx";
import { Alert } from "./components/ui/Alert.tsx";
import { LoadingState } from "./components/ui/LoadingState.tsx";
import { LoginForm } from "./components/LoginForm.tsx";
import { AppShell } from "./components/layout/AppShell.tsx";
import { UsersPanel } from "./components/UsersPanel.tsx";
import { KeysPanel } from "./components/KeysPanel.tsx";
import { PluginsPanel } from "./components/PluginsPanel.tsx";
import { FeatureFlagsPanel } from "./components/FeatureFlagsPanel.tsx";
import { SecurityPanel } from "./components/SecurityPanel.tsx";
import { OverviewPanel } from "./components/dashboard/OverviewPanel.tsx";
import { HomePanel } from "./components/dashboard/HomePanel.tsx";
import { IdentityProvidersPanel } from "./components/dashboard/IdentityProvidersPanel.tsx";
import { OrganizationSelector } from "./components/dashboard/OrganizationSelector.tsx";
import { SettingsPanel } from "./components/dashboard/SettingsPanel.tsx";
import { ConnectProjectPanel } from "./components/ConnectProjectPanel.tsx";
import { SessionsPanel } from "./components/SessionsPanel.tsx";
import { PasskeysPanel } from "./components/PasskeysPanel.tsx";
import { ProfilePanel } from "./components/ProfilePanel.tsx";
import { WebhooksPanel } from "./components/WebhooksPanel.tsx";
import { useAuth } from "./hooks/useAuth.ts";
import { useAsync } from "./hooks/useAsync.ts";
import { useUiMode } from "./hooks/useUiMode.ts";
import { useHealth } from "./hooks/useHealth.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useTranslation } from "./i18n/index.ts";
import { ModeToggle } from "./components/ui/ModeToggle.tsx";
import { CommandPalette } from "./components/ui/CommandPalette.tsx";
import { Advanced } from "./components/ui/Advanced.tsx";
import { HealthBadge } from "./components/ui/HealthBadge.tsx";
import { DiagnosticsDrawer } from "./components/dashboard/DiagnosticsDrawer.tsx";
import { parseError } from "./lib/errorMessages.ts";
import { useHashRoute } from "./hooks/useHashRoute.ts";

const OrganizationsPanel = lazy(() => import("./components/OrganizationsPanel.tsx").then((m) => ({ default: m.OrganizationsPanel })));
const ApplicationsPanel = lazy(() => import("./components/ApplicationsPanel.tsx").then((m) => ({ default: m.ApplicationsPanel })));
const AuditLogsPanel = lazy(() => import("./components/AuditLogsPanel.tsx").then((m) => ({ default: m.AuditLogsPanel })));
const EnterpriseSsoPanel = lazy(() => import("./components/EnterpriseSsoPanel.tsx").then((m) => ({ default: m.EnterpriseSsoPanel })));
const WorkflowPanel = lazy(() => import("./components/WorkflowPanel.tsx").then((m) => ({ default: m.WorkflowPanel })));
const BillingPanel = lazy(() => import("./components/BillingPanel.tsx").then((m) => ({ default: m.BillingPanel })));
const RolesPermissionsPanel = lazy(() => import("./components/RolesPermissionsPanel.tsx").then((m) => ({ default: m.RolesPermissionsPanel })));
const QueuePanel = lazy(() => import("./components/QueuePanel.tsx").then((m) => ({ default: m.QueuePanel })));
const MetricsPanel = lazy(() => import("./components/MetricsPanel.tsx").then((m) => ({ default: m.MetricsPanel })));

export interface DataTabState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface PluginSummary {
  metadata: { name: string; version: string; description?: string; author?: string; homepage?: string };
  extensionPoints: string[];
}

interface ExtensionPointSummary {
  name: string;
  description: string;
  registered: string[];
}

interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string | null;
  source: "database" | "environment";
}

interface ConfigurationProfile {
  id: string;
  name: string;
  description: string;
}

interface SamlConnection {
  id: string;
  name: string;
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  spEntityId: string;
  spAcsUrl: string;
  isActive: boolean;
  createdAt: string;
}

interface OidcConnection {
  id: string;
  name: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  clientId: string;
  scopes: string[];
  isActive: boolean;
  createdAt: string;
}

interface WorkflowItem {
  id: string;
  name: string;
  trigger: string;
  definition: { steps: Array<{ type: string; name?: string }> };
  isActive: boolean;
  createdAt: string;
}

interface WorkflowRun {
  id: string;
  status: string;
  triggerEvent: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: Array<{ step: string; status: string; error?: string }>;
}

interface Plan {
  id: string;
  name: string;
  description: string;
}

const API_BASE = import.meta.env.VITE_KEYSTONE_API_URL || "http://localhost:4001";

const TABS = [
  { id: "overview", label: "Home", icon: <Activity className="w-4 h-4" />, group: "Home", mode: "simple" as const },
  { id: "profile", label: "Profile", icon: <UserCircle className="w-4 h-4" />, group: "Home", mode: "simple" as const },
  { id: "users", label: "Users", icon: <Users className="w-4 h-4" />, group: "Authentication", mode: "simple" as const },
  { id: "applications", label: "Applications", icon: <LayoutGrid className="w-4 h-4" />, group: "Authentication", mode: "simple" as const },
  { id: "connect-project", label: "Connect Project", icon: <Code2 className="w-4 h-4" />, group: "Authentication", mode: "simple" as const },
  { id: "identity-providers", label: "Identity Providers", icon: <Plug className="w-4 h-4" />, group: "Authentication", mode: "advanced" as const },
  { id: "organizations", label: "Organizations", icon: <Building2 className="w-4 h-4" />, group: "Access Control", mode: "advanced" as const },
  { id: "roles", label: "Roles", icon: <ShieldCheck className="w-4 h-4" />, group: "Access Control", mode: "advanced" as const },
  { id: "enterprise-sso", label: "Enterprise SSO", icon: <Shield className="w-4 h-4" />, group: "Access Control", mode: "advanced" as const },
  { id: "keys", label: "Keys", icon: <Lock className="w-4 h-4" />, group: "Access Control", mode: "advanced" as const },
  { id: "security", label: "Security", icon: <Shield className="w-4 h-4" />, group: "Access Control", mode: "advanced" as const },
  { id: "sessions", label: "Sessions", icon: <Monitor className="w-4 h-4" />, group: "Access Control", mode: "advanced" as const },
  { id: "workflows", label: "Workflows", icon: <Workflow className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "webhooks", label: "Webhooks", icon: <Webhook className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "queue", label: "Queue", icon: <Layers className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "audit-logs", label: "Audit Logs", icon: <ScrollText className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "plugins", label: "Plugins", icon: <Puzzle className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "feature-flags", label: "Feature Flags", icon: <ToggleLeft className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "billing", label: "Billing", icon: <CreditCard className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "metrics", label: "Metrics", icon: <BarChart3 className="w-4 h-4" />, group: "Platform", mode: "advanced" as const },
  { id: "settings", label: "Settings", icon: <Settings className="w-4 h-4" />, group: "Platform", mode: "simple" as const },
];

interface DashboardProps {
  initialTab?: string;
}

export default function Dashboard({ initialTab = "overview" }: DashboardProps) {
  const { navigate } = useHashRoute();
  const { token, user, loading: authLoading, error: authError, logout } = useAuth();
  const { mode, setMode } = useUiMode();
  const health = useHealth();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();
  const [activeTab, setActiveTabState] = useState(initialTab);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    navigate(`/dashboard/${encodeURIComponent(tab)}`);
  }, [navigate]);

  const visibleTabs = useMemo(
    () =>
      TABS.filter((tab) => mode === "advanced" || tab.mode === "simple").map((tab) => ({
        ...tab,
        label: t(`nav.${tab.id}`) !== `nav.${tab.id}` ? t(`nav.${tab.id}`) : tab.label,
        group: t(`group.${tab.group.toLowerCase().replace(/ /g, "-")}`) !== `group.${tab.group.toLowerCase().replace(/ /g, "-")}`
          ? t(`group.${tab.group.toLowerCase().replace(/ /g, "-")}`)
          : tab.group,
      })),
    [mode, t]
  );

  // Keep tab in sync with URL hash (e.g. browser back/forward).
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const match = hash.match(/^\/dashboard\/(.+)$/);
    if (match) {
      const tab = decodeURIComponent(match[1]);
      if (tab !== activeTab) {
        setActiveTabState(tab);
      }
    }
  }, [activeTab]);

  // If the active tab is hidden by the current UI mode, fall back to Home.
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, visibleTabs, setActiveTab]);

  const {
    data: overviewData,
    loading: overviewLoading,
    error: overviewError,
  } = useAsync(async () => {
    const [health, config, queueStatus] = await Promise.all([
      api.getHealth(),
      api.getOpenIdConfig(),
      api.getQueueStatus(),
    ]);
    return { health, config, queueStatus };
  }, [token]);

  // Tab data states
  const [users, setUsers] = useState<DataTabState<{ users: unknown[] }>>({ data: null, loading: false, error: null });
  const [organizations, setOrganizations] = useState<DataTabState<{ organizations: unknown[] }>>({ data: null, loading: false, error: null });
  const [applications, setApplications] = useState<DataTabState<{ applications: unknown[] }>>({ data: null, loading: false, error: null });
  const [platformConfig, setPlatformConfig] = useState<DataTabState<{ values: Record<string, string> }>>({ data: null, loading: false, error: null });
  const [auditLogs, setAuditLogs] = useState<DataTabState<{ logs: unknown[] }>>({ data: null, loading: false, error: null });
  const [providers, setProviders] = useState<DataTabState<{ providers: Array<{ type: string; name: string; configured: boolean }> }>>({ data: null, loading: false, error: null });
  const [keys, setKeys] = useState<DataTabState<{ keys: Array<{ keyId: string; createdAt: string; expiresAt?: string | null }>; provider: string }>>({ data: null, loading: false, error: null });
  const [plugins, setPlugins] = useState<DataTabState<{ plugins: PluginSummary[] }>>({ data: null, loading: false, error: null });
  const [extensions, setExtensions] = useState<DataTabState<{ extensionPoints: ExtensionPointSummary[] }>>({ data: null, loading: false, error: null });
  const [featureFlags, setFeatureFlags] = useState<DataTabState<{ flags: FeatureFlag[] }>>({ data: null, loading: false, error: null });
  const [configProfiles, setConfigProfiles] = useState<DataTabState<{ profiles: ConfigurationProfile[] }>>({ data: null, loading: false, error: null });
  const [samlConnections, setSamlConnections] = useState<DataTabState<{ connections: SamlConnection[] }>>({ data: null, loading: false, error: null });
  const [oidcConnections, setOidcConnections] = useState<DataTabState<{ connections: OidcConnection[] }>>({ data: null, loading: false, error: null });
  const [scimConfig, setScimConfig] = useState<DataTabState<{ enabled: boolean; baseUrl: string; orgId: string }>>({ data: null, loading: false, error: null });
  const [workflows, setWorkflows] = useState<DataTabState<{ workflows: WorkflowItem[] }>>({ data: null, loading: false, error: null });
  const [workflowRuns, setWorkflowRuns] = useState<DataTabState<{ runs: WorkflowRun[] }>>({ data: null, loading: false, error: null });
  const [plans, setPlans] = useState<DataTabState<{ plans: Plan[] }>>({ data: null, loading: false, error: null });
  const [billingSummary, setBillingSummary] = useState<DataTabState<{ plan: string }>>({ data: null, loading: false, error: null });
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [dismissedChecklist, setDismissedChecklist] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("keystone:dismiss-checklist") === "true";
  });

  // Tab loaders
  async function loadTab<T>(state: DataTabState<T>, setState: (value: DataTabState<T>) => void, fetcher: () => Promise<T>) {
    if (state.data) return;
    setState({ ...state, loading: true, error: null });
    try {
      const data = await fetcher();
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const refreshUsers = useCallback(() => loadTab({ data: null, loading: false, error: null }, setUsers, api.getUsers), []);
  const refreshOrganizations = useCallback(() => loadTab({ data: null, loading: false, error: null }, setOrganizations, api.getOrganizations), []);
  const refreshApplications = useCallback(() => loadTab({ data: null, loading: false, error: null }, setApplications, api.getApplications), []);
  const refreshAuditLogs = useCallback((event?: string) => loadTab({ data: null, loading: false, error: null }, setAuditLogs, () => api.getAuditLogs(event)), []);
  const refreshKeys = useCallback(() => loadTab({ data: null, loading: false, error: null }, setKeys, api.getSigningKeys), []);
  const refreshPlugins = useCallback(() => {
    loadTab({ data: null, loading: false, error: null }, setPlugins, api.getPlugins);
    loadTab({ data: null, loading: false, error: null }, setExtensions, api.getPluginExtensionPoints);
  }, []);
  const refreshFeatureFlags = useCallback(() => {
    loadTab({ data: null, loading: false, error: null }, setFeatureFlags, api.getFeatureFlags);
    loadTab({ data: null, loading: false, error: null }, setConfigProfiles, api.getConfigurationProfiles);
  }, []);
  const refreshEnterpriseSso = useCallback(() => {
    if (!selectedOrgId) return;
    loadTab({ data: null, loading: false, error: null }, setSamlConnections, () => api.getSamlConnections(selectedOrgId));
    loadTab({ data: null, loading: false, error: null }, setOidcConnections, () => api.getOidcConnections(selectedOrgId));
    loadTab({ data: null, loading: false, error: null }, setScimConfig, () => api.getScimConfig(selectedOrgId));
  }, [selectedOrgId]);
  const refreshWorkflows = useCallback(() => loadTab({ data: null, loading: false, error: null }, setWorkflows, api.getWorkflows), []);
  const refreshBilling = useCallback(() => {
    loadTab({ data: null, loading: false, error: null }, setPlans, api.getPlans);
    if (selectedOrgId) {
      loadTab({ data: null, loading: false, error: null }, setBillingSummary, () => api.getBillingSummary(selectedOrgId));
    }
  }, [selectedOrgId]);

  // Event handlers
  const handleUnregisterPlugin = useCallback(async (name: string) => {
    await api.unregisterPlugin(name);
    refreshPlugins();
  }, [refreshPlugins]);
  const handleToggleFeatureFlag = useCallback(async (key: string, enabled: boolean) => {
    await api.setFeatureFlag(key, enabled);
    refreshFeatureFlags();
  }, [refreshFeatureFlags]);
  const handleDeleteFeatureFlag = useCallback(async (key: string) => {
    await api.deleteFeatureFlag(key);
    refreshFeatureFlags();
  }, [refreshFeatureFlags]);
  const handleCreateFeatureFlag = useCallback(async (key: string, enabled: boolean, description?: string) => {
    await api.setFeatureFlag(key, enabled, description);
    refreshFeatureFlags();
  }, [refreshFeatureFlags]);
  const handleCreateSaml = useCallback(async (input: { name: string; spEntityId: string; spAcsUrl: string }) => {
    if (!selectedOrgId) return;
    await api.createSamlConnection(selectedOrgId, input);
    refreshEnterpriseSso();
  }, [selectedOrgId, refreshEnterpriseSso]);
  const handleDeleteSaml = useCallback(async (id: string) => {
    if (!selectedOrgId) return;
    await api.deleteSamlConnection(selectedOrgId, id);
    refreshEnterpriseSso();
  }, [selectedOrgId, refreshEnterpriseSso]);
  const handleCreateOidc = useCallback(async (input: { name: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; clientSecret: string }) => {
    if (!selectedOrgId) return;
    await api.createOidcConnection(selectedOrgId, input);
    refreshEnterpriseSso();
  }, [selectedOrgId, refreshEnterpriseSso]);
  const handleDeleteOidc = useCallback(async (id: string) => {
    if (!selectedOrgId) return;
    await api.deleteOidcConnection(selectedOrgId, id);
    refreshEnterpriseSso();
  }, [selectedOrgId, refreshEnterpriseSso]);
  const handleCreateWorkflow = useCallback(async (input: { name: string; trigger: string; definition: { steps: Array<{ type: string; name?: string }> } }) => {
    await api.createWorkflow(input);
    refreshWorkflows();
  }, [refreshWorkflows]);
  const handleDeleteWorkflow = useCallback(async (id: string) => {
    await api.deleteWorkflow(id);
    if (selectedWorkflowId === id) setSelectedWorkflowId(null);
    refreshWorkflows();
  }, [selectedWorkflowId, refreshWorkflows]);
  const handleLoadWorkflowRuns = useCallback(async (id: string) => {
    loadTab({ data: null, loading: false, error: null }, setWorkflowRuns, () => api.getWorkflowRuns(id));
  }, []);
  const handleChangePlan = useCallback(async (plan: string) => {
    if (!selectedOrgId) return;
    await api.updateOrganizationPlan(selectedOrgId, plan);
    refreshBilling();
    refreshOrganizations();
  }, [selectedOrgId, refreshBilling, refreshOrganizations]);
  const handleProvisionCustomer = useCallback(async () => {
    if (!selectedOrgId) return;
    await api.provisionBillingCustomer(selectedOrgId);
    refreshBilling();
  }, [selectedOrgId, refreshBilling]);

  useEffect(() => {
    if (selectedOrgId) return;
    const orgs = organizations.data?.organizations as Array<{ id: string }> | undefined;
    if (orgs && orgs.length > 0) {
      setSelectedOrgId(orgs[0].id);
    }
  }, [organizations.data, selectedOrgId]);

  useEffect(() => {
    if (!token) return;
    switch (activeTab) {
      case "users":
        loadTab(users, setUsers, api.getUsers);
        break;
      case "organizations":
        loadTab(organizations, setOrganizations, api.getOrganizations);
        break;
      case "applications":
        loadTab(applications, setApplications, api.getApplications);
        break;
      case "connect-project":
        loadTab(applications, setApplications, api.getApplications);
        loadTab(platformConfig, setPlatformConfig, api.getConfig);
        break;
      case "audit-logs":
        loadTab(auditLogs, setAuditLogs, api.getAuditLogs);
        break;
      case "identity-providers":
        loadTab(providers, setProviders, api.getFederationProviders);
        break;
      case "keys":
        loadTab(keys, setKeys, api.getSigningKeys);
        break;
      case "plugins":
        loadTab(plugins, setPlugins, api.getPlugins);
        loadTab(extensions, setExtensions, api.getPluginExtensionPoints);
        break;
      case "feature-flags":
        loadTab(featureFlags, setFeatureFlags, api.getFeatureFlags);
        loadTab(configProfiles, setConfigProfiles, api.getConfigurationProfiles);
        break;
      case "enterprise-sso":
        refreshEnterpriseSso();
        break;
      case "workflows":
        loadTab(workflows, setWorkflows, api.getWorkflows);
        break;
      case "billing":
        refreshBilling();
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, token]);

  if (!token) {
    return <LoginForm onLogin={() => window.location.reload()} />;
  }

  const logo = useMemo(
    () => (
      <div className="w-9 h-9 rounded-lg btn-gold flex items-center justify-center">
        <span className="text-sm font-bold">K</span>
      </div>
    ),
    []
  );

  const headerActions = useMemo(
    () => (
      <>
        {user && (
          <span className="hidden sm:inline text-[13px] txt-muted truncate max-w-[140px]">
            {user.email}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={toggleTheme}
          className="px-2 sm:px-4"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={logout}
          className="px-2 sm:px-4"
          title="Logout"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline ml-1.5">Logout</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => window.open(`${API_BASE}/documentation`, "_blank")}
          className="px-2 sm:px-4"
          title="API Docs"
        >
          <BookOpen className="w-4 h-4" />
          <span className="hidden sm:inline ml-1.5">API Docs</span>
        </Button>
      </>
    ),
    [user, logout, theme, toggleTheme]
  );

  const renderContent = () => {
    if (authLoading || overviewLoading) {
      return <LoadingState message="Loading dashboard…" />;
    }

    if (authError) {
      const friendly = parseError(authError);
      return (
        <Alert variant="error" className="mb-4">
          <div className="space-y-2">
            <p>{friendly.message}</p>
            {friendly.action && <p className="text-[12px] opacity-90">{friendly.action}</p>}
          </div>
        </Alert>
      );
    }

    if (overviewError) {
      const friendly = parseError(overviewError);
      return (
        <Alert variant="error" className="mb-4">
          <div className="space-y-2">
            <p>{friendly.message}</p>
            {friendly.action && <p className="text-[12px] opacity-90">{friendly.action}</p>}
          </div>
        </Alert>
      );
    }

    const { health, config, queueStatus } = overviewData ?? { health: null, config: null, queueStatus: null };

    switch (activeTab) {
      case "profile":
        return <ProfilePanel />;
      case "overview":
        return (
          <>
            <HomePanel
              onNavigate={setActiveTab}
              health={health}
              orgCount={(organizations.data?.organizations ?? []).length}
              appCount={(applications.data?.applications ?? []).length}
              providerCount={(providers.data?.providers ?? []).filter((p) => p.configured).length}
              userCount={(users.data?.users ?? []).length}
              dismissedChecklist={dismissedChecklist}
              onDismissChecklist={() => {
                setDismissedChecklist(true);
                localStorage.setItem("keystone:dismiss-checklist", "true");
              }}
            />
            <Advanced mode={mode}>
              <div className="mt-5">
                <OverviewPanel health={health} config={config} queueStatus={queueStatus} />
              </div>
            </Advanced>
          </>
        );
      case "organizations":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <OrganizationsPanel state={organizations} onRefresh={refreshOrganizations} />
          </Suspense>
        );
      case "applications":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <ApplicationsPanel state={applications} organizations={organizations} onRefresh={refreshApplications} />
          </Suspense>
        );
      case "connect-project":
        return <ConnectProjectPanel applicationsState={applications} configState={platformConfig} />;
      case "users":
        return <UsersPanel state={users} onRefresh={refreshUsers} mode={mode} />;
      case "identity-providers":
        return <IdentityProvidersPanel state={providers} />;
      case "keys":
        return <KeysPanel state={keys} onRefresh={refreshKeys} />;
      case "security":
        return (
          <div className="space-y-5">
            <SecurityPanel />
            <PasskeysPanel />
          </div>
        );
      case "sessions":
        return <SessionsPanel />;
      case "plugins":
        return (
          <PluginsPanel
            pluginsState={plugins}
            extensionsState={extensions}
            onRefresh={refreshPlugins}
            onUnregister={handleUnregisterPlugin}
          />
        );
      case "feature-flags":
        return (
          <FeatureFlagsPanel
            flagsState={featureFlags}
            profilesState={configProfiles}
            onRefresh={refreshFeatureFlags}
            onToggle={handleToggleFeatureFlag}
            onDelete={handleDeleteFeatureFlag}
            onCreate={handleCreateFeatureFlag}
          />
        );
      case "enterprise-sso":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <>
              <OrganizationSelector
                organizations={(organizations.data?.organizations as Array<{ id: string; name: string }> | undefined) ?? []}
                selectedId={selectedOrgId}
                onChange={setSelectedOrgId}
                className="mb-4"
              />
              <EnterpriseSsoPanel
                samlState={samlConnections}
                oidcState={oidcConnections}
                scimState={scimConfig}
                selectedOrgId={selectedOrgId}
                onRefresh={refreshEnterpriseSso}
                onCreateSaml={handleCreateSaml}
                onDeleteSaml={handleDeleteSaml}
                onCreateOidc={handleCreateOidc}
                onDeleteOidc={handleDeleteOidc}
              />
            </>
          </Suspense>
        );
      case "workflows":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <WorkflowPanel
              workflowsState={workflows}
              runsState={workflowRuns}
              selectedWorkflowId={selectedWorkflowId}
              onSelectWorkflow={setSelectedWorkflowId}
              onRefresh={refreshWorkflows}
              onCreate={handleCreateWorkflow}
              onDelete={handleDeleteWorkflow}
              onLoadRuns={handleLoadWorkflowRuns}
            />
          </Suspense>
        );
      case "webhooks":
        return <WebhooksPanel />;
      case "roles":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <RolesPermissionsPanel />
          </Suspense>
        );
      case "billing":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <>
              <OrganizationSelector
                organizations={(organizations.data?.organizations as Array<{ id: string; name: string }> | undefined) ?? []}
                selectedId={selectedOrgId}
                onChange={setSelectedOrgId}
                className="mb-4"
              />
              <BillingPanel
                plansState={plans}
                billingState={billingSummary}
                currentPlan={
                  (organizations.data?.organizations as Array<{ id: string; plan: string }> | undefined)?.find(
                    (o) => o.id === selectedOrgId
                  )?.plan ?? "free"
                }
                selectedOrgId={selectedOrgId}
                onRefresh={refreshBilling}
                onChangePlan={handleChangePlan}
                onProvisionCustomer={handleProvisionCustomer}
              />
            </>
          </Suspense>
        );
      case "queue":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <QueuePanel />
          </Suspense>
        );
      case "audit-logs":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <AuditLogsPanel state={auditLogs} onRefresh={refreshAuditLogs} />
          </Suspense>
        );
      case "metrics":
        return (
          <Suspense fallback={<LoadingState message="Loading panel…" />}>
            <MetricsPanel />
          </Suspense>
        );
      case "settings":
        return <SettingsPanel />;
      default:
        return null;
    }
  };

  const modeToggle = useMemo(() => <ModeToggle mode={mode} onChange={setMode} />, [mode, setMode]);

  const sidebarFooter = useMemo(
    () => (
      <button
        onClick={() => setDiagnosticsOpen(true)}
        className="w-full p-2 rounded-xl bg-surface border border-theme/20 hover:border-gold/30 transition-colors"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-medium txt-head">Status</span>
          <span className="text-[10px] txt-muted">Click for details</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <HealthBadge status={health.api} label="API" />
          <HealthBadge status={health.database} label="DB" />
          <HealthBadge status={health.redis} label="Redis" />
        </div>
      </button>
    ),
    [health]
  );

  const commandItems = useMemo(
    () =>
      visibleTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        group: tab.group,
        onSelect: () => setActiveTab(tab.id),
      })),
    [visibleTabs, setActiveTab]
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <AppShell
      title="Keystone Admin"
      subtitle="Identity Platform"
      logo={logo}
      sidebarItems={visibleTabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      headerActions={headerActions}
      modeToggle={modeToggle}
      sidebarFooter={sidebarFooter}
    >
      <div
        key={`${activeTab}-${mode}`}
        className="animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both"
      >
        {renderContent()}
      </div>
      <CommandPalette items={commandItems} isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <DiagnosticsDrawer
        isOpen={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        api={health.api}
        database={health.database}
        redis={health.redis}
        setupComplete={health.setupComplete}
      />
    </AppShell>
  );
}
