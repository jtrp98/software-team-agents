using System.Text.Json.Serialization;

namespace StaPlatform.Application.Sta;

/// <summary>
/// The client surface of STA Core's Local API — the deterministic TypeScript
/// core STA ships with. The platform never reimplements execution: it drives
/// this API, exactly like the STA Web UI and `sta work` CLI do.
/// </summary>
public interface IStaCoreClient
{
    Task<bool> PingAsync(CancellationToken ct = default);
    Task<IReadOnlyList<StaKnowledgeInfo>> ListKnowledgeAsync(CancellationToken ct = default);
    Task<StaKnowledgeModules?> ListModulesAsync(string knowledgeName, CancellationToken ct = default);
    Task<IReadOnlyList<StaRunSummary>> ListRunsAsync(string? status = null, string? knowledge = null, string? module = null, CancellationToken ct = default);
    Task<StaRunDetail?> GetRunAsync(string runId, CancellationToken ct = default);
    /// <summary>Aggregate diff of a run's frozen work (the human review aid — STA computes, platform relays).</summary>
    Task<StaRunDiff?> GetRunDiffAsync(string runId, CancellationToken ct = default);
    /// <summary>The git commands a PERSON runs to merge the run branch — STA never pushes or merges.</summary>
    Task<StaPrepareCommit?> GetPrepareCommitAsync(string runId, CancellationToken ct = default);
    Task<StaCreateRunResult?> CreateRunAsync(string knowledge, string module, string commandText, CancellationToken ct = default);
    Task<StaRunDetail?> PauseAsync(string runId, CancellationToken ct = default);
    Task<StaRunDetail?> ResumeAsync(string runId, CancellationToken ct = default);
    Task<StaRunDetail?> StopAsync(string runId, bool force = false, CancellationToken ct = default);
    Task<StaRunDetail?> ApproveAsync(string runId, string by, string? note, CancellationToken ct = default);
    Task<StaRunDetail?> SendBackAsync(string runId, string by, string note, CancellationToken ct = default);
    Task<StaRuntimes?> ListRuntimesAsync(CancellationToken ct = default);
}

public class StaKnowledgeInfo
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public string State { get; set; } = "";
    public bool IsDefault { get; set; }
    public List<string> Problems { get; set; } = [];
    public List<string> Warnings { get; set; } = [];
    public List<string> Modules { get; set; } = [];
    public List<StaTargetInfo> Targets { get; set; } = [];
}

public class StaTargetInfo
{
    [JsonPropertyName("targetId")] public string TargetId { get; set; } = "";
    public string? Type { get; set; }
    public string? Status { get; set; }
    [JsonPropertyName("localPath")] public string? LocalPath { get; set; }
}

public class StaKnowledgeModules
{
    public string Knowledge { get; set; } = "";
    public List<string> Modules { get; set; } = [];
    public List<StaTargetInfo> Targets { get; set; } = [];
}

public class StaRunSummary
{
    [JsonPropertyName("runId")] public string RunId { get; set; } = "";
    public string Knowledge { get; set; } = "";
    public string Module { get; set; } = "";
    public string Status { get; set; } = "";
    [JsonPropertyName("statusReason")] public string? StatusReason { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    [JsonPropertyName("openGates")] public int OpenGates { get; set; }
}

public class StaRunDetail
{
    public StaRun Run { get; set; } = new();
    [JsonPropertyName("runtimeEvents")] public List<StaRuntimeEvent> RuntimeEvents { get; set; } = [];
}

public class StaRun
{
    [JsonPropertyName("runId")] public string RunId { get; set; } = "";
    public StaKnowledgeRef Knowledge { get; set; } = new();
    public string Module { get; set; } = "";
    public string Status { get; set; } = "";
    [JsonPropertyName("statusReason")] public string? StatusReason { get; set; }
    [JsonPropertyName("commandText")] public string? CommandText { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    [JsonPropertyName("humanGates")] public List<StaHumanGate> HumanGates { get; set; } = [];
    [JsonPropertyName("workers")] public StaWorkers? Workers { get; set; }
    public StaSnapshot? Snapshot { get; set; }
    [JsonPropertyName("runtimeHistory")] public List<StaRuntimeEvent> RuntimeHistory { get; set; } = [];
}

public class StaKnowledgeRef
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
}

public class StaWorkers
{
    [JsonPropertyName("engineer")] public string? Engineer { get; set; }
    [JsonPropertyName("reviewer")] public string? Reviewer { get; set; }
    public string? Qa { get; set; }
}

public class StaHumanGate
{
    public string Id { get; set; } = "";
    public long At { get; set; }
    public string Kind { get; set; } = "";
    public string Reason { get; set; } = "";
    [JsonPropertyName("resolvedAt")] public long? ResolvedAt { get; set; }
}

public class StaRuntimeEvent
{
    public long At { get; set; }
    [JsonPropertyName("runtimeId")] public string RuntimeId { get; set; } = "";
    public string? Role { get; set; }
    public string Event { get; set; } = "";
    [JsonPropertyName("failureClass")] public string? FailureClass { get; set; }
    public string? Detail { get; set; }
}

public class StaSnapshotTask
{
    [JsonPropertyName("taskId")] public string TaskId { get; set; } = "";
    public int Phase { get; set; }
    public string Status { get; set; } = "";
    public string? Stage { get; set; }
    public string? Reason { get; set; }
}

public class StaSnapshot
{
    [JsonPropertyName("currentTask")] public string? CurrentTask { get; set; }
    [JsonPropertyName("currentStage")] public string? CurrentStage { get; set; }
    public List<StaSnapshotTask>? Tasks { get; set; }
}

public class StaCreateRunResult
{
    public StaRun? Run { get; set; }
}

public class StaRunDiff
{
    public string Diff { get; set; } = "";
    public bool Truncated { get; set; }
    public string? Note { get; set; }
}

public class StaPrepareCommit
{
    public string Note { get; set; } = "";
    [JsonPropertyName("targetRoots")] public List<string?> TargetRoots { get; set; } = [];
    public List<string> Commands { get; set; } = [];
}

public class StaRuntimes
{
    public List<StaRuntimeStatus> Statuses { get; set; } = [];
}

public class StaRuntimeStatus
{
    [JsonPropertyName("runtimeId")] public string RuntimeId { get; set; } = "";
    [JsonPropertyName("installed")] public bool Installed { get; set; }
    public string? Version { get; set; }
    public string? Authentication { get; set; }
    public string? State { get; set; }
    [JsonPropertyName("securityRoles")] public Dictionary<string, bool>? SecurityRoles { get; set; }
    [JsonPropertyName("securityDetail")] public string? SecurityDetail { get; set; }
}
