namespace StaPlatform.Domain.Entities;

/// <summary>
/// A Role-Owned Human Gate (spec §11): a decision STA needs from the human
/// responsible for that decision in that scope. The gate routes by
/// Organization + Knowledge + Module + required_role; only authorized humans
/// may answer, and every answer records the acting role.
/// </summary>
public class HumanGate
{
    public int Id { get; set; }
    public int OrganizationId { get; set; }
    public int KnowledgeId { get; set; }
    public Knowledge Knowledge { get; set; } = null!;
    public string? Module { get; set; }
    /// <summary>Canonical gate type from gate_policies (e.g. ARCHITECTURE_DECISION).</summary>
    public required string GateType { get; set; }
    /// <summary>Resolved from gate_policies at creation; null for creator-routed operational gates.</summary>
    public string? RequiredRole { get; set; }
    public GateRoutingMode RoutingMode { get; set; } = GateRoutingMode.AnyAuthorized;
    public int? AssigneeId { get; set; }
    public User? Assignee { get; set; }
    public GateStatus Status { get; set; } = GateStatus.Open;
    public required string Question { get; set; }
    /// <summary>JSON: work context the gate was raised from (task, stage, reason…).</summary>
    public string? ContextJson { get; set; }
    public string? AiAnalysis { get; set; }
    /// <summary>JSON: options the answerer may pick from, when applicable.</summary>
    public string? OptionsJson { get; set; }
    /// <summary>JSON: what this gate blocks (STA run ids, STA gate keys, task ids).</summary>
    public string? BlockedRefsJson { get; set; }
    /// <summary>STA Core's own gate key within a run — the dedupe identity for auto-created gates.</summary>
    public string? StaGateKey { get; set; }
    public string? StaRunId { get; set; }
    /// <summary>Set when this gate relays an engine approval decision — the STA task holding the approval ledger.</summary>
    public string? StaApprovalTaskId { get; set; }
    public string? StaApprovalRequestId { get; set; }
    public ActorType CreatedByType { get; set; } = ActorType.System;
    public int? CreatedById { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? AnsweredAt { get; set; }
    public int? AnsweredById { get; set; }
    public User? AnsweredBy { get; set; }
    /// <summary>The role the answerer held when answering — one user may answer different gates under different roles (spec §14).</summary>
    public string? ActingRole { get; set; }
    /// <summary>JSON: {approved, choice, comment}.</summary>
    public string? DecisionJson { get; set; }

    /// <summary>Human-facing label (HG-1042 style) derived from the int4 PK.</summary>
    public string DisplayId => $"HG-{Id}";
}

public enum GateStatus
{
    Open = 1,
    Assigned = 2,
    Waiting = 3,
    Answered = 4,
    Cancelled = 5,
    Superseded = 6,
}

public enum GateRoutingMode
{
    /// <summary>Every authorized holder of the required role may answer; first valid answer wins.</summary>
    AnyAuthorized = 1,
    /// <summary>Highest-priority assignment first; backups visible but cannot commit first.</summary>
    PrimaryThenBackup = 2,
    /// <summary>One explicit person.</summary>
    SpecificAssignee = 3,
}

public enum ActorType
{
    System = 1,
    User = 2,
    Ai = 3,
}

public static class GateTypes
{
    public const string RequirementDecision = "REQUIREMENT_DECISION";
    public const string ScopeDecision = "SCOPE_DECISION";
    public const string UxDecision = "UX_DECISION";
    public const string ArchitectureDecision = "ARCHITECTURE_DECISION";
    public const string DevDecision = "DEV_DECISION";
    public const string QaDecision = "QA_DECISION";
    public const string SecurityDecision = "SECURITY_DECISION";
    public const string ReleaseDecision = "RELEASE_DECISION";
    public const string Review = "REVIEW";
    /// <summary>Operational stop (halted/refused/interrupted/…) — routed to the run's creator, not a business role.</summary>
    public const string Operational = "OPERATIONAL";
}
