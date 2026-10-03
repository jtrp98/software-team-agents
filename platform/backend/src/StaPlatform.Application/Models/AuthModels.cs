namespace StaPlatform.Application.Models;

public record LoginRequest(string Email, string Password);
public record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public record AuthResponse(string AccessToken, DateTime AccessTokenExpiresAt, string RefreshToken, DateTime RefreshTokenExpiresAt, MeResponse User);
public record RefreshRequest(string RefreshToken);
public record MeResponse(int Id, string Email, string Name, bool IsOrgAdmin, IReadOnlyList<string> VisibleKnowledgeNames);

public record UserDto(int Id, string Email, string Name, string Status, bool IsOrgAdmin, DateTime CreatedAt, DateTime? LastLoginAt, IReadOnlyList<AssignmentDto> Assignments);
public record InviteUserRequest(string Email, string Name, string Password, bool OrgAdmin = false);
public record SetUserStatusRequest(string Status);
public record ResetPasswordRequest(string NewPassword);

public record AssignmentDto(int Id, string Role, int? KnowledgeId, string? KnowledgeName, string? Module, int Priority);
public record SetAssignmentsRequest(IReadOnlyList<AssignmentInput> Assignments);
public record AssignmentInput(string Role, int? KnowledgeId, string? Module, int Priority = 0);
public record EffectiveRolesResponse(IReadOnlyList<string> Roles);
