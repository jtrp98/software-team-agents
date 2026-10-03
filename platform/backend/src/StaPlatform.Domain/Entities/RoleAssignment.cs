namespace StaPlatform.Domain.Entities;

/// <summary>
/// One role of one user in one scope. Scope is a priority ladder:
/// (Knowledge=null, Module=null) = organization-wide; (Knowledge, Module=null) =
/// Knowledge-level; (Knowledge, Module) = Module-level. Higher Priority wins
/// when a gate routes primary-then-backup.
/// </summary>
public class RoleAssignment
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    public int UserId { get; set; }
    public User User { get; set; } = null!;
    /// <summary>Stable canonical id from the role catalog (e.g. "sa", "dev_lead").</summary>
    public required string Role { get; set; }
    public int? KnowledgeId { get; set; }
    public Knowledge? Knowledge { get; set; }
    public string? Module { get; set; }
    /// <summary>"{knowledgeId}|{module}" of the scope — makes (user, role, scope) unique even across NULL scopes.</summary>
    public required string ScopeKey { get; set; }
    public int Priority { get; set; }
    public DateTime CreatedAt { get; set; }
}
