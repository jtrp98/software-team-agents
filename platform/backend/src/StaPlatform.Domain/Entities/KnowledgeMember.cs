namespace StaPlatform.Domain.Entities;

/// <summary>Membership of a user in a Knowledge. Visibility and run access are gated on this — checked server-side, every request.</summary>
public class KnowledgeMember
{
    public int KnowledgeId { get; set; }
    public Knowledge Knowledge { get; set; } = null!;
    public int UserId { get; set; }
    public User User { get; set; } = null!;
    public DateTime CreatedAt { get; set; }
}
