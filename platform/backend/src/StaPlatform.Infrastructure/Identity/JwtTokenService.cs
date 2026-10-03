using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.IdentityModel.Tokens;
using StaPlatform.Application.Common;

namespace StaPlatform.Infrastructure.Identity;

public class JwtOptions
{
    public const string Section = "Jwt";
    public required string Secret { get; set; }
    public string Issuer { get; set; } = "sta-platform";
    public string Audience { get; set; } = "sta-platform-web";
    public int AccessTokenMinutes { get; set; } = 60;
}

public class JwtTokenService(JwtOptions options) : ITokenService
{
    public (string Token, DateTime ExpiresAt) CreateAccessToken(int userId, string email, string name, int organizationId, bool isOrgAdmin)
    {
        var expires = DateTime.UtcNow.AddMinutes(options.AccessTokenMinutes);
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Email, email),
            new("name", name),
            new("org", organizationId.ToString()),
            new("org_admin", isOrgAdmin ? "1" : "0"),
        };
        var credentials = new SigningCredentials(
            new SymmetricSecurityKey(System.Text.Encoding.UTF8.GetBytes(options.Secret)), SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(options.Issuer, options.Audience, claims, notBefore: DateTime.UtcNow, expires: expires, signingCredentials: credentials);
        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }

    public (string Token, string TokenHash) NewRefreshToken()
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(48)).ToLowerInvariant();
        return (token, HashRefreshToken(token));
    }

    public string HashRefreshToken(string token) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
}
