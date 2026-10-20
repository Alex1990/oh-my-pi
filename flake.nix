{
  description = "OMP coding agent and development environment";

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable dropped Intel macOS in 26.11; keep that supported
    # platform on the final stable branch that still receives security fixes.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin-x64,
      rust-overlay,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        (if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs).legacyPackages.${system};

      rustToolchainFor =
        system:
        (rust-overlay.lib.mkRustBin { } (pkgsFor system)).fromRustupToolchainFile ./rust-toolchain.toml;

      localPackagesFor =
        system:
        {
          rustToolchain = rustToolchainFor system;
        };

      packageFor =
        system:
        let
          pkgs = pkgsFor system;
          localPkgs = localPackagesFor system;
        in
        pkgs.callPackage ./nix/package.nix (
          {
            source = self.outPath;
          }
          // localPkgs
        );
    in
    {
      packages = forAllSystems (
        system:
        let
          omp = packageFor system;
        in
        {
          inherit omp;
          default = omp;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/omp";
          meta.description = "Run OMP";
        };
        omp = self.apps.${system}.default;
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          localPackages = localPackagesFor system;
        in
        {
          default = import ./nix/dev-shell.nix ({ inherit pkgs; } // localPackages);
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          homeManagerEvaluation = pkgs.lib.evalModules {
            specialArgs = { inherit pkgs; };
            modules = [
              {
                options.home.packages = pkgs.lib.mkOption {
                  type = pkgs.lib.types.listOf pkgs.lib.types.package;
                  default = [ ];
                };
                options.home.activation = pkgs.lib.mkOption {
                  type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
                  default = { };
                };
              }
              self.homeManagerModules.default
              {
                programs.omp.enable = true;
                programs.omp.settings.startup.quiet = true;
              }
            ];
          };
          nixosEvaluation = pkgs.lib.evalModules {
            specialArgs = { inherit pkgs; };
            modules = [
              {
                options.environment.systemPackages = pkgs.lib.mkOption {
                  type = pkgs.lib.types.listOf pkgs.lib.types.package;
                  default = [ ];
                };
              }
              self.nixosModules.default
              { programs.omp.enable = true; }
            ];
          };
          modulesEvaluate =
            assert builtins.elem self.packages.${system}.default homeManagerEvaluation.config.home.packages;
            assert homeManagerEvaluation.config.home.activation ? ompConfig;
            assert builtins.elem self.packages.${system}.default
              nixosEvaluation.config.environment.systemPackages;
            pkgs.runCommand "omp-module-evaluation" { } "touch $out";
        in
        {
          # Verify the committed lockfile matches every workspace manifest.
          # `--lockfile-only` resolves the graph without downloading packages,
          # so this needs no network in the sandbox.
          pnpm-lock = pkgs.runCommand "omp-pnpm-lock" { nativeBuildInputs = [ pkgs.pnpm ]; } ''
            cp -R ${self.outPath} source
            chmod -R u+w source
            cd source
            export HOME=$TMPDIR
            pnpm install --frozen-lockfile --lockfile-only --ignore-scripts --offline
            touch "$out"
          '';
          modules = modulesEvaluate;
          omp = self.packages.${system}.default;
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);

      overlays.default = _final: previous: {
        omp = self.packages.${previous.stdenv.hostPlatform.system}.default;
      };

      homeManagerModules.default = import ./nix/home-manager.nix { inherit self; };
      homeManagerModules.omp = self.homeManagerModules.default;
      nixosModules.default = import ./nix/nixos-module.nix { inherit self; };
      nixosModules.omp = self.nixosModules.default;
    };
}
