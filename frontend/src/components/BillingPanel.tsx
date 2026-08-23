import { useState } from "react";
import { Activity, CreditCard, Crown, CheckCircle2 } from "lucide-react";
import { Card } from "./ui/Card.tsx";
import { Button } from "./ui/Button.tsx";
import { Alert } from "./ui/Alert.tsx";
import type { DataTabState } from "../Dashboard.tsx";

interface Plan {
  id: string;
  name: string;
  description: string;
}

interface BillingSummary {
  plan: string;
  provider?: string;
  subscription?: Record<string, unknown>;
}

interface BillingPanelProps {
  plansState: DataTabState<{ plans: Plan[] }>;
  billingState: DataTabState<BillingSummary>;
  currentPlan: string;
  selectedOrgId: string | null;
  onRefresh: () => void;
  onChangePlan: (plan: string) => Promise<void>;
  onProvisionCustomer: () => Promise<void>;
}

export function BillingPanel({
  plansState,
  billingState,
  currentPlan,
  selectedOrgId,
  onRefresh,
  onChangePlan,
  onProvisionCustomer,
}: BillingPanelProps) {
  const [isProvisioning, setIsProvisioning] = useState(false);

  if (plansState.loading || billingState.loading) {
    return (
      <div className="py-20 flex flex-col items-center gap-3 text-muted-foreground">
        <Activity className="w-8 h-8 animate-spin text-gold" />
        <p className="text-[14px]">Loading billing…</p>
      </div>
    );
  }

  if (plansState.error || billingState.error) {
    return (
      <Alert variant="error" className="mt-6">
        Unable to load billing: {plansState.error || billingState.error}
      </Alert>
    );
  }

  if (!selectedOrgId) {
    return (
      <Alert variant="info" className="mt-6">
        Select an organization to manage billing.
      </Alert>
    );
  }

  const plans = plansState.data?.plans ?? [];
  const summary = billingState.data;

  return (
    <div className="mt-6 space-y-4">
      <Card variant="glass" className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-semibold txt-head flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-gold" />
            Current Plan
          </h3>
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-gold/10 flex items-center justify-center text-gold">
            <Crown className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[18px] font-semibold txt-head capitalize">{summary?.plan || currentPlan}</p>
            {summary?.provider ? (
              <p className="text-[12px] txt-muted">Provider: {summary.provider}</p>
            ) : (
              <p className="text-[12px] txt-muted">No billing provider configured</p>
            )}
          </div>
        </div>
        {summary?.subscription && (
          <pre className="mt-4 text-[11px] txt-head bg-surface p-3 rounded-lg overflow-auto">
            {JSON.stringify(summary.subscription, null, 2)}
          </pre>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="mt-4"
          onClick={async () => {
            setIsProvisioning(true);
            await onProvisionCustomer().finally(() => setIsProvisioning(false));
          }}
          isLoading={isProvisioning}
        >
          Provision Billing Customer
        </Button>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {plans.map((plan) => {
          const active = (summary?.plan || currentPlan) === plan.id;
          return (
            <Card
              key={plan.id}
              variant={active ? "default" : "glass"}
              className={`p-5 flex flex-col ${active ? "border-gold/50" : ""}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[14px] font-semibold txt-head">{plan.name}</span>
                {active && <CheckCircle2 className="w-4 h-4 text-gold" />}
              </div>
              <p className="text-[12px] txt-muted flex-1">{plan.description}</p>
              <Button
                size="sm"
                variant={active ? "secondary" : "primary"}
                className="mt-4"
                onClick={() => onChangePlan(plan.id)}
                disabled={active}
              >
                {active ? "Current Plan" : "Select Plan"}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
