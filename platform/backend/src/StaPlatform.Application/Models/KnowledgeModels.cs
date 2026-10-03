namespace StaPlatform.Application.Models;

public record KnowledgeDto(
    int Id,
    string Name,
    string? RepositoryUrl,
    string? DefaultBranch,
    string Status,
    bool RegisteredOnThisMachine,
    DateTime CreatedAt,
    IReadOnlyList<string> Modules,
    IReadOnlyList<MemberDto> Members,
    bool IsMember);

public record AddKnowledgeRequest(string Name, string? RepositoryUrl, string? DefaultBranch, bool RegisterOnStaMachine = true);
public record MemberDto(int UserId, string Name, string Email, string Status);
public record AddMemberRequest(int UserId);
public record RoleCatalogDto(string Role, string DisplayName);
public record GatePolicyDto(string GateType, string RequiredRole);
