namespace StaPlatform.Domain.Entities;

/// <summary>Membership of a user in an organization, with the organization-level role (org admin manages users/knowledge/pools).</summary>
public class OrganizationMember
{
    public int OrganizationId { get; set; }
    public Organization Organization { get; set; } = null!;
    public int UserId { get; set; }
    public User User { get; set; } = null!;
    public OrgRole OrgRole { get; set; } = OrgRole.Member;
    public DateTime CreatedAt { get; set; }
}

public enum OrgRole
{
    Member = 1,
    OrgAdmin = 2,
}
