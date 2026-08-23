interface Organization {
  id: string;
  name: string;
}

interface OrganizationSelectorProps {
  organizations: Organization[];
  selectedId: string | null;
  onChange: (id: string) => void;
  label?: string;
  className?: string;
}

export function OrganizationSelector({
  organizations,
  selectedId,
  onChange,
  label = "Organization",
  className = "",
}: OrganizationSelectorProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="text-[13px] txt-muted">{label}:</span>
      <select
        className="bg-surface border border-theme/30 rounded-lg px-3 py-1.5 text-[13px] txt-head"
        value={selectedId ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </div>
  );
}
