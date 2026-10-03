using System.IdentityModel.Tokens.Jwt;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using StaPlatform.Api.Auth;
using StaPlatform.Api.Endpoints;
using StaPlatform.Api.Middleware;
using StaPlatform.Api.Startup;
using StaPlatform.Api.Workers;
using StaPlatform.Application.Common;
using StaPlatform.Application.Services;
using StaPlatform.Infrastructure;
using StaPlatform.Infrastructure.Identity;
using StaPlatform.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();

builder.Services.AddInfrastructure(builder.Configuration);
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUserService, CurrentUserAccessor>();
// Schema + seed run as the FIRST hosted service, from the same provider that serves every request.
builder.Services.AddHostedService<StartupMigrationService>();
builder.Services.AddHostedService<StaCoreSyncWorker>();

var jwt = builder.Configuration.GetSection(JwtOptions.Section).Get<JwtOptions>()
    ?? throw new InvalidOperationException("Jwt:Secret is not set — ตั้ง Jwt__Secret ใน env ก่อนรัน");
if (string.IsNullOrWhiteSpace(jwt.Secret) || jwt.Secret.Length < 32)
    throw new InvalidOperationException("Jwt:Secret ต้องยาวอย่างน้อย 32 ตัวอักษร");

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwt.Issuer,
            ValidateAudience = true,
            ValidAudience = jwt.Audience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Secret)),
            ValidateLifetime = true,
        };
        // The browser speaks cookies; the CLI speaks Authorization headers. Both are the same JWT.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var cookie = context.Request.Cookies[AuthCookies.Access];
                if (!string.IsNullOrEmpty(cookie) && string.IsNullOrEmpty(context.Token))
                    context.Token = cookie;
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

var frontendOrigin = builder.Configuration["Cors:FrontendOrigin"] ?? "http://localhost:3000";
builder.Services.AddCors(options => options.AddPolicy("frontend", policy =>
    policy.WithOrigins(frontendOrigin).AllowCredentials().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

app.UseMiddleware<ExceptionMiddleware>();
app.UseCors("frontend");
app.UseAuthentication();
app.UseAuthorization();

app.MapMetaEndpoints();
app.MapAuthEndpoints(secureCookies: !app.Environment.IsDevelopment());
app.MapUserEndpoints();
app.MapKnowledgeEndpoints();
app.MapGateEndpoints();
app.MapRunEndpoints();
app.MapPoolEndpoints();
app.MapTeamEndpoints();

app.Run();

public partial class Program;
