namespace StaPlatform.Domain.Entities;

/// <summary>A human user of the platform. Authority never lives here — it is the sum of role assignments (many-to-many, scoped).</summary>
public class User
{
    public int Id { get; set; }
    public required string Email { get; set; }
    public required string Name { get; set; }
    public required string PasswordHash { get; set; }
    public UserStatus Status { get; set; } = UserStatus.Invited;
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }

    public ICollection<OrganizationMember> OrganizationMemberships { get; set; } = new List<OrganizationMember>();
}

public enum UserStatus
{
    Invited = 1,
    Active = 2,
    Suspended = 3,
    Disabled = 4,
}
