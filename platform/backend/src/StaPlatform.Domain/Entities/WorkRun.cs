namespace StaPlatform.Domain.Entities;

/// <summary>
/// The platform's reference to a STA Core work run. The run's execution truth
/// lives in STA Core (`core.db`); this mirror holds what the platform needs for
/// visibility and role-based access: who asked for it, on which Knowledge and
/// module — and the last status seen from the Local API.
/// </summary>
public class WorkRun
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    /// <summary>STA Core's run id (wr-…), unique.</summary>
    public required string StaRunId { get; set; }
    public int KnowledgeId { get; set; }
    public Knowledge Knowledge { get; set; } = null!;
    public required string Module { get; set; }
    /// <summary>Null when the run was started outside the platform (STA CLI / STA Web UI) — provenance still visible via audit.</summary>
    public int? CreatedById { get; set; }
    public User? CreatedBy { get; set; }
    public string? LastStatus { get; set; }
    public string? LastStatusReason { get; set; }
    /// <summary>Runtime events newer than this (epoch ms, STA side) are folded into runtime_usage by the sync worker.</summary>
    public long LastSyncedEventAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
