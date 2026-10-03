namespace StaPlatform.Domain.Entities;

/// <summary>
/// Platform metadata of a Knowledge. The knowledge *content* lives in its Git
/// repository; this row is the system metadata (org binding, members, gates,
/// run references). The name is the STA Core machine-local root name used by
/// the Local API.
/// </summary>
public class Knowledge
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    public Organization Organization { get; set; } = null!;
    public required string Name { get; set; }
    public required string Slug { get; set; }
    public string? RepositoryUrl { get; set; }
    public string? DefaultBranch { get; set; }
    public KnowledgeStatus Status { get; set; } = KnowledgeStatus.Ready;
    public bool RegisteredOnThisMachine { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    public ICollection<KnowledgeMember> Members { get; set; } = new List<KnowledgeMember>();
}

public enum KnowledgeStatus
{
    Ready = 1,
    Warning = 2,
    Invalid = 3,
    Missing = 4,
}
