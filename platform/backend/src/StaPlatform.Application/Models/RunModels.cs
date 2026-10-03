namespace StaPlatform.Application.Models;

public record StartRunRequest(string KnowledgeName, string Module, string CommandText);
public record RunListDto(
    string StaRunId,
    int KnowledgeId,
    string KnowledgeName,
    string Module,
    string? Status,
    string? StatusReason,
    int OpenGates,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedByName);
public record TeamRowDto(string TaskId, int Phase, string Status, string? Stage, string? Role, string? WaitingOn, string StaRunId);

public record ConnectionDto(
    int Id,
    string RuntimeType,
    string OwnerType,
    int OwnerId,
    string? OwnerLabel,
    string SharingScope,
    string Status,
    string? Label,
    string? MachineName,
    string? StaState,
    string? StaAuthentication,
    DateTime CreatedAt);

public record AddConnectionRequest(string RuntimeType, string OwnerType, int OwnerId, string SharingScope, string? Label);
public record UpdateConnectionRequest(string? Status, string? SharingScope);
public record PoolResolveRow(string RuntimeType, int ConnectionId, string OwnerType, string PoolTier);
public record ResolveOrderResponse(string Policy, string? ResponsibleUserName, IReadOnlyList<PoolResolveRow> Order);
