using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using StaPlatform.Application.Common;
using StaPlatform.Application.Services;
using StaPlatform.Application.Sta;
using StaPlatform.Infrastructure.Identity;
using StaPlatform.Infrastructure.Persistence;
using StaPlatform.Infrastructure.StaCore;

namespace StaPlatform.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<AppDbContext>(options =>
        {
            var connectionString = configuration.GetConnectionString("Default")
                ?? throw new InvalidOperationException(
                    "ConnectionStrings__Default is not set — ตั้ง connection string ของ Supabase Postgres ใน env ก่อนรัน");
            options.UseNpgsql(connectionString);
        });
        services.AddScoped<IAppDbContext>(sp => sp.GetRequiredService<AppDbContext>());

        services.Configure<JwtOptions>(configuration.GetSection(JwtOptions.Section));
        services.Configure<StaCoreOptions>(configuration.GetSection(StaCoreOptions.Section));
        services.AddSingleton(configuration.GetSection(JwtOptions.Section).Get<JwtOptions>() ?? new JwtOptions { Secret = "unconfigured" });
        services.AddSingleton(configuration.GetSection(StaCoreOptions.Section).Get<StaCoreOptions>() ?? new StaCoreOptions());

        services.AddSingleton<IPasswordHasher, Pbkdf2PasswordHasher>();
        services.AddSingleton<ITokenService, JwtTokenService>();

        services.AddHttpClient("sta-core");
        services.AddSingleton<StaCoreClient>();
        services.AddSingleton<IStaCoreClient>(sp => sp.GetRequiredService<StaCoreClient>());

        services.AddScoped<AuthService>();
        services.AddScoped<UserService>();
        services.AddScoped<AssignmentService>();
        services.AddScoped<KnowledgeService>();
        services.AddScoped<GateService>();
        services.AddScoped<RunService>();
        services.AddScoped<PoolService>();
        services.AddScoped<TeamService>();
        services.AddScoped<AuditService>();
        services.AddScoped<StaCoreSyncService>();

        return services;
    }
}
