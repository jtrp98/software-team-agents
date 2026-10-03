namespace StaPlatform.Application.Models;

public record GateCardDto(
    int Id,
    string DisplayId,
    string GateType,
    string? RequiredRole,
    string Status,
    string KnowledgeName,
    string? Module,
    string Question,
    string? AiAnalysis,
    IReadOnlyList<string> Options,
    string? StaRunId,
    string? AssigneeName,
    DateTime CreatedAt,
    string? AnsweredByName,
    string? ActingRole,
    string? DecisionSummary,
    bool CanAnswer);

public record GateDetailDto(
    GateCardDto Gate,
    string? ContextJson,
    string? BlockedRefsJson,
    string RoutingMode);

public record CreateGateRequest(
    string GateType,
    int KnowledgeId,
    string? Module,
    string Question,
    string? AiAnalysis,
    IReadOnlyList<string>? Options,
    string? ContextJson,
    string? StaRunId,
    string? StaGateKey,
    string? RoutingMode,
    int? AssigneeId);

public record AnswerGateRequest(bool? Approved, string? Choice, string? Comment);
public record ReassignGateRequest(int AssigneeId);
