namespace StaPlatform.Domain.Entities;

/// <summary>A refresh token (hashed at rest). The short-lived access token is a JWT and is never stored.</summary>
public class RefreshToken
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public User User { get; set; } = null!;
    public required string TokenHash { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}
