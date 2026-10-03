namespace StaPlatform.Domain.Entities;

/// <summary>An organization (tenant). Phase 2 ships one default organization; the model never closes off multi-organization.</summary>
public class Organization
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string Slug { get; set; }
    public OrganizationStatus Status { get; set; } = OrganizationStatus.Active;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public enum OrganizationStatus
{
    Active = 1,
    Disabled = 2,
}
