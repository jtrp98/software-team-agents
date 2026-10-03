using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Common;
using StaPlatform.Infrastructure.StaCore;

namespace StaPlatform.Api.Middleware;

/// <summary>One error shape for the frontend: ProblemDetails with the use-case's Thai message, an honest status, no stack traces.</summary>
public class ExceptionMiddleware(RequestDelegate next, ILogger<ExceptionMiddleware> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
        }
        catch (Exception error)
        {
            if (context.Response.HasStarted) throw;
            var (status, title) = error switch
            {
                AppException app => (app.Status, "request failed"),
                DbUpdateConcurrencyException => (409, "conflict"),
                StaCoreNotFoundException => (404, "sta-core not found"),
                StaCoreException => (502, "sta-core error"),
                _ => (500, "internal error"),
            };
            if (status >= 500) logger.LogError(error, "unhandled error on {Method} {Path}", context.Request.Method, context.Request.Path);
            else logger.LogInformation("{Type} on {Method} {Path}: {Message}", error.GetType().Name, context.Request.Method, context.Request.Path, error.Message);

            context.Response.StatusCode = status;
            context.Response.ContentType = "application/problem+json";
            var problem = new ProblemDetails
            {
                Status = status,
                Title = title,
                Detail = status >= 500 ? "เกิดข้อผิดพลาดภายใน — ดู log ของ backend" : error.Message,
            };
            await context.Response.WriteAsync(JsonSerializer.Serialize(problem, Json));
        }
    }
}
