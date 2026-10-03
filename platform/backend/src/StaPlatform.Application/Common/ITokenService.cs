namespace StaPlatform.Application.Common;

public interface IPasswordHasher
{
    string Hash(string password);
    bool Verify(string password, string hash);
}

public interface ITokenService
{
    /// <summary>Creates a short-lived signed JWT carrying identity + organization claims.</summary>
    (string Token, DateTime ExpiresAt) CreateAccessToken(int userId, string email, string name, int organizationId, bool isOrgAdmin);
    /// <summary>A cryptographically random refresh token; only its hash is stored.</summary>
    (string Token, string TokenHash) NewRefreshToken();
    string HashRefreshToken(string token);
}
