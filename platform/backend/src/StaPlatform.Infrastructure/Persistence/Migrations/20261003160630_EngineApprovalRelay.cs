using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StaPlatform.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class EngineApprovalRelay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "StaApprovalRequestId",
                table: "HumanGates",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "StaApprovalTaskId",
                table: "HumanGates",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "StaApprovalRequestId",
                table: "HumanGates");

            migrationBuilder.DropColumn(
                name: "StaApprovalTaskId",
                table: "HumanGates");
        }
    }
}
