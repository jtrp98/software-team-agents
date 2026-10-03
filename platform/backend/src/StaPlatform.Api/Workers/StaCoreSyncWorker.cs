using StaPlatform.Application.Services;
using StaPlatform.Application.Sta;

namespace StaPlatform.Api.Workers;

/// <summary>
/// The platform's heartbeat to STA Core: mirror run statuses, auto-create
/// role-owned gates from a run's human gates, close gates answered in STA,
/// fold runtime events into usage. Best-effort by design — STA Core may be
/// offline and every later pass catches up.
/// </summary>
public class StaCoreSyncWorker(IServiceProvider services, ILogger<StaCoreSyncWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<StaCoreSyncService>().SyncOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                logger.LogWarning(error, "STA sync pass failed; retrying on the next tick");
            }
            try { await timer.WaitForNextTickAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }
}
