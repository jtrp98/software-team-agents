namespace StaPlatform.Application.Common;

/// <summary>A use-case failure with an HTTP meaning. The API middleware turns it into a ProblemDetails response.</summary>
public class AppException : Exception
{
    public int Status { get; }

    public AppException(string message, int status = 400) : base(message) => Status = status;

    public static AppException NotFound(string message) => new(message, 404);
    public static AppException Unauthorized(string message = "authentication required") => new(message, 401);
    public static AppException Forbidden(string message) => new(message, 403);
    public static AppException Conflict(string message) => new(message, 409);
}
