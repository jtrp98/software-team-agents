namespace StaPlatform.Application.Common;

/// <summary>The authenticated principal a use case acts for. Populated from the validated JWT.</summary>
public record CurrentUser
{
    public required int UserId { get; init; }
    public required string Email { get; init; }
    public required string Name { get; init; }
    public required int OrganizationId { get; init; }
    public required bool IsOrgAdmin { get; init; }
}

/// <summary>Access to the current principal inside use cases.</summary>
public interface ICurrentUserService
{
    CurrentUser? User { get; }
    CurrentUser RequireUser();
    CurrentUser RequireOrgAdmin();
}
