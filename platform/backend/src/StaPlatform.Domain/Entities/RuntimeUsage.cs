namespace StaPlatform.Domain.Entities;

/// <summary>
/// One recorded execution on a runtime connection. Token usage is stored only
/// when the runtime actually reports it — never fabricated (spec §79).
/// Billing-ready by organization/knowledge/user/connection, not a billing system.
/// </summary>
public class RuntimeUsage
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    public required string RuntimeType { get; set; }
    public RuntimeOwnerType OwnerType { get; set; }
    public int OwnerId { get; set; }
    public string? StaRunId { get; set; }
    public string? Role { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public string? Outcome { get; set; }
    public string? FailureClass { get; set; }
    public string? Detail { get; set; }
}
