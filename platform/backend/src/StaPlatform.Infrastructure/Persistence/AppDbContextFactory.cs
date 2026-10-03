using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace StaPlatform.Infrastructure.Persistence;

/// <summary>
/// Design-time factory for `dotnet ef migrations` — reads
/// `ConnectionStrings__Default` from the environment (your Supabase connection
/// string) and falls back to a placeholder so migrations can be generated
/// without a live database.
/// </summary>
public class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ConnectionStrings__Default")
            ?? "Host=localhost;Port=5432;Database=sta_platform;Username=postgres;Password=postgres";
        var options = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(connectionString).Options;
        return new AppDbContext(options);
    }
}
