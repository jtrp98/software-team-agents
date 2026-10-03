using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using StaPlatform.Application.Services;
using StaPlatform.Infrastructure.Persistence;

namespace StaPlatform.Api.Startup;

/// <summary>
/// Startup: apply the schema and seed the default organization + admin account
/// before any request is served. Runs as the first hosted service so it works
/// from the same service provider every request uses — including under
/// WebApplicationFactory. Controlled by STA_RUN_MIGRATIONS=1 or Development.
/// The bootstrap admin password comes from STA_ADMIN_PASSWORD; without one, a
/// generated password is written once to a local file.
/// </summary>
public class StartupMigrationService(
    IServiceProvider services,
    IHostEnvironment environment,
    ILogger<StartupMigrationService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var runMigrations = environment.IsDevelopment() || Environment.GetEnvironmentVariable("STA_RUN_MIGRATIONS") == "1";
        if (!runMigrations) return;

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (db.Database.IsRelational()) await db.Database.MigrateAsync(cancellationToken);

        var password = Environment.GetEnvironmentVariable("STA_ADMIN_PASSWORD");
        var generated = false;
        if (string.IsNullOrWhiteSpace(password))
        {
            password = Convert.ToHexString(RandomNumberGenerator.GetBytes(12));
            generated = true;
        }
        await scope.ServiceProvider.GetRequiredService<AuthService>().SeedAsync(password, cancellationToken);

        if (generated)
        {
            var file = Path.Combine(environment.ContentRootPath, "bootstrap-admin-credentials.txt");
            if (!File.Exists(file))
            {
                await File.WriteAllTextAsync(file,
                    $"Email: admin@sta.local\nPassword: {password}\n\nเข้าสู่ระบบครั้งแรก เปลี่ยนรหัสผ่าน แล้วลบไฟล์นี้\n", cancellationToken);
                logger.LogWarning("bootstrap admin credentials written to {File} — delete the file after the first sign-in", file);
            }
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
