namespace StaPlatform.Domain.Entities;

/// <summary>Stable canonical role ids with editable display names (spec §10: never branch subsystems by role).</summary>
public class RoleCatalogItem
{
    public required string Role { get; set; }
    public required string DisplayName { get; set; }
    public int SortOrder { get; set; }
}

/// <summary>Data-driven gate_type → required_role policy (spec §12). Editable rows; the resolver reads the table, never a switch.</summary>
public class GatePolicy
{
    public required string GateType { get; set; }
    public required string RequiredRole { get; set; }
}
