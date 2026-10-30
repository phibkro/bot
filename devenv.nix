{ pkgs, ... }:
{
  # Toolchain only (Provenance: adapted from phibkro/pg-txmode @ 23be53c0c66a129540350697253b5c19abde3171 (devenv.nix);
  # deviation: no PostgreSQL or PgBouncer). Vite+ needs Node >= 22.18. gitleaks scans the full history in CI and by hand.
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    pkgs.gitleaks
    pkgs.jq
  ];
}
