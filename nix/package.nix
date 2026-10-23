{
  addDriverRunpath,
  autoPatchelfHook,
  alsa-lib,
  cmake,
  config,
  cudaPackages_13 ? null,
  darwin,
  fetchPnpmDeps,
  lib,
  libpulseaudio,
  makeShellWrapper,
  ninja,
  nodejs_24,
  pkg-config,
  pipewire,
  pnpm,
  pnpmConfigHook,
  rustPlatform,
  rustToolchain,
  source,
  stdenv,
  # onnxruntime-node (downloaded into the agent cache on first use) ships CUDA
  # execution providers that dlopen vendor libraries absent from the NixOS
  # loader path. Enabling this appends them to the inference workers'
  # LD_LIBRARY_PATH so the GPU provider loads instead of quietly degrading to
  # CPU. Mirrors nixpkgs' `cudaSupport` convention (sunshine, obs-studio,
  # btop). Note the closure cost — libcublas ~745 MB, libcurand ~136 MB,
  # cuda_cudart ~74 MB — so this stays opt-in and off by default.
  cudaSupport ? config.cudaSupport,
  # Wayland screencast support links libpipewire, whose runtime closure adds
  # ~750 MB (gstreamer, ffmpeg, systemd, ...). Official npm/Bazel addons ship
  # without it, so default to the lean build; opt in via `.override`.
  withWaylandScreencast ? false,
}:
let
  packageJson = lib.importJSON ../packages/coding-agent/package.json;
  platform =
    {
      aarch64-darwin = {
        addon = "pi_natives.darwin-arm64.node";
        nativeLibrary = "libpi_natives.dylib";
      };
      aarch64-linux = {
        addon = "pi_natives.linux-arm64.node";
        nativeLibrary = "libpi_natives.so";
      };
      x86_64-darwin = {
        addon = "pi_natives.darwin-x64-baseline.node";
        nativeLibrary = "libpi_natives.dylib";
        rustFlags = "-C target-cpu=x86-64-v2";
      };
      x86_64-linux = {
        addon = "pi_natives.linux-x64-baseline.node";
        nativeLibrary = "libpi_natives.so";
        rustFlags = "-C target-cpu=x86-64-v2";
      };
    }
    .${stdenv.hostPlatform.system} or (throw "Unsupported OMP platform: ${stdenv.hostPlatform.system}");
  # Vendor libraries the on-demand onnxruntime-node CUDA execution provider
  # dlopens. These are not needed for the addon itself to load (postFixup's
  # wrapper covers libstdc++/libgcc), but the provider is its own .so whose
  # dependencies sit outside the NixOS loader path, so the worker needs them on
  # LD_LIBRARY_PATH to load a GPU provider instead of degrading to CPU.
  #
  # CUDA 13 specifically: the shipped provider's sonames are libcublasLt.so.13 /
  # libcublas.so.13 / libcurand.so.10 / libcudart.so.13. CUDA 12 (nixpkgs'
  # default `cudaPackages`) only provides .so.12, so taking this build's
  # `cudaPackages` would silently fail to resolve them; pin the 13.x series.
  # Verified by dlopen: without these the provider dies on libcublasLt.so.13.
  cudaRuntimeLibraries =
    let
      # The driver itself (libcuda.so.1) is not a redistributable: it only
      # exists at the host's driver link, which is stable across driver
      # upgrades and present exactly when the machine can run CUDA at all.
      driver = addDriverRunpath.driverLink;
      libDirs = lib.concatMap (p: [ (lib.getLib p) ]) [
        cudaPackages_13.libcublas
        cudaPackages_13.libcurand
        cudaPackages_13.cuda_cudart
      ];
    in
    lib.optionals (cudaSupport && stdenv.hostPlatform.isLinux && cudaPackages_13 != null) (
      [ driver ] ++ libDirs
    );
  runtimeNativeLibraries =
    lib.optionals stdenv.hostPlatform.isLinux (
      [ stdenv.cc.cc.lib ] ++ lib.optional (stdenv.cc.cc ? libgcc) stdenv.cc.cc.libgcc
    )
    ++ cudaRuntimeLibraries;
in
stdenv.mkDerivation {
  pname = "omp";
  inherit (packageJson) version;
  src = source;

  cargoDeps = rustPlatform.importCargoLock { lockFile = ../Cargo.lock; };
  # Dependencies come from `pnpm-lock.yaml`. When that file changes, replace
  # `hash` with the SRI hash Nix reports on the failed fixed-output build.
  pnpmDeps = fetchPnpmDeps {
    pname = "omp";
    inherit (packageJson) version;
    src = source;
    hash = lib.fakeHash;
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeShellWrapper
    cmake
    ninja
    pkg-config
    rustPlatform.bindgenHook
    rustPlatform.cargoSetupHook
    rustToolchain
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  # libgcc_s is resolved from the compiler's lib output during autoPatchelf.
  buildInputs =
    lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ]
    ++ lib.optionals withWaylandScreencast [ pipewire ];

  strictDeps = true;
  # Nix builders cannot reliably hardlink cache files into node_modules
  # (and Darwin's clonefile backend also rejects store permissions).
  pnpmInstallFlags = [
    "--frozen-lockfile"
    "--ignore-scripts"
    "--package-import-method=copy"
  ];
  dontStrip = true;

  env = {
    CMAKE_POLICY_VERSION_MINIMUM = "3.5";
    PCRE2_SYS_STATIC = "1";
    SOURCE_DATE_EPOCH = "1";
  }
  // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; };

  buildPhase = ''
    runHook preBuild

    echo "Building pi-natives"
    cargo build --release -p pi-natives ${lib.optionalString withWaylandScreencast "--features wayland-pipewire"}
    install -Dm755 "target/release/${platform.nativeLibrary}" \
      "packages/natives/native/${platform.addon}"
    # The loader and embed-native.ts require the release version, which is
    # written into the addon after linking (build-bindings.ts does this for
    # local builds; this raw cargo build must do it itself).
    node --experimental-transform-types scripts/stamp-native-version.ts --no-sign \
      "packages/natives/native/${platform.addon}"
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # pi-voice dlopens libpulse-simple.so.0 / libpulse.so.0 / libasound.so.2
      # by bare name; glibc resolves those through the calling object's
      # RUNPATH, so append the client libraries here. Nothing links them, so
      # autoPatchelf cannot discover them on its own.
      patchelf --add-rpath "${
        lib.makeLibraryPath [
          libpulseaudio
          alsa-lib
        ]
      }" \
        "packages/natives/native/${platform.addon}"
    ''}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # The darwin stdenv links C code against darwin.libiconv, whose install
      # name is an absolute /nix/store path. Repoint it at the system libiconv
      # (dyld shared cache, same ABI) so the addon loads on target machines.
      install_name_tool -change "${darwin.libiconv}/lib/libiconv.2.dylib" \
        /usr/lib/libiconv.2.dylib "packages/natives/native/${platform.addon}"
    ''}

    echo "Compiling OMP"
    pnpm --dir packages/coding-agent run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # The launcher resolves `cli.js` next to itself; the marker package.json
    # makes Node treat the esbuild ESM bundle as an ES module.
    install -Dm755 packages/coding-agent/dist/omp "$out/libexec/omp/omp"
    install -Dm644 packages/coding-agent/dist/cli.js "$out/libexec/omp/cli.js"
    printf '%s\n' '{"type":"module"}' > "$out/libexec/omp/package.json"

    # The native addon stays external so it can load through napi. Mirror the
    # workspace layout the bundle resolves from: node_modules/@oh-my-pi/pi-natives.
    install -Dm755 "packages/natives/native/${platform.addon}" \
      "$out/libexec/omp/packages/natives/native/${platform.addon}"
    mkdir -p "$out/libexec/omp/node_modules/@oh-my-pi"
    ln -s ../../packages/natives "$out/libexec/omp/node_modules/@oh-my-pi/pi-natives"

    install -Dm644 LICENSE "$out/share/doc/omp/LICENSE"
    install -Dm644 THIRD-PARTY-NOTICES.txt "$out/share/doc/omp/THIRD-PARTY-NOTICES.txt"

    runHook postInstall
  '';

  # The launcher is a shell script; the wrapper supplies Node on PATH and the
  # runtime library path the addons and inference workers need.
  postFixup = ''
    wrapperArgs=(--prefix PATH : "${lib.makeBinPath [ nodejs_24 ]}")
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      wrapperArgs+=(--set-default OMP_NATIVE_LIBRARY_PATH "${lib.makeLibraryPath runtimeNativeLibraries}")
    ''}
    makeShellWrapper "$out/libexec/omp/omp" "$out/bin/omp" "''${wrapperArgs[@]}"
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    # Capture rather than pipe into grep: piping masks a signal death of omp
    # under `set -o pipefail` (grep -q's exit status wins).
    smokeOutput="$(HOME="$TMPDIR" "$out/bin/omp" --smoke-test)"
    grep -q "smoke-test: ok" <<<"$smokeOutput"
    nodeVersion="$("$out/bin/omp" --version)"
    case "$nodeVersion" in
      *${packageJson.version}*) ;;
      *) echo "unexpected version: $nodeVersion" >&2; exit 1 ;;
    esac
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # The addons are dlopen'd, so prove the advertised directories actually
      # resolve the libraries rather than merely carrying a plausible string.
      libPath="${lib.makeLibraryPath runtimeNativeLibraries}"
      for lib in libstdc++.so.6 libgcc_s.so.1; do
        found=0
        oldIFS=$IFS; IFS=:
        for dir in $libPath; do
          if [ -e "$dir/$lib" ]; then found=1; break; fi
        done
        IFS=$oldIFS
        if [ "$found" -ne 1 ]; then
          echo "unresolved: $lib" >&2
          exit 1
        fi
      done
    ''}${
      lib.optionalString (cudaSupport && stdenv.hostPlatform.isLinux && cudaPackages_13 != null) ''
        # The CUDA provider must actually resolve, not merely be advertised: the
        # wrong CUDA major is invisible at runtime (onnxruntime silently falls
        # back to CPU), so assert the exact sonames the provider dlopens. Only the
        # redistributable libraries are checked here — the driver's libcuda.so.1
        # lives at the host's driver link, which does not exist in this sandbox
        # and is not a property of the build.
        libPath="${lib.makeLibraryPath runtimeNativeLibraries}"
        for lib in libcublasLt.so.13 libcublas.so.13 libcurand.so.10 libcudart.so.13; do
          found=0
          oldIFS=$IFS; IFS=:
          for dir in $libPath; do
            if [ -e "$dir/$lib" ]; then found=1; break; fi
          done
          IFS=$oldIFS
          if [ "$found" -ne 1 ]; then
            echo "unresolved: $lib" >&2
            exit 1
          fi
        done
      ''
    }
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      # The smoke test above can pass in the build sandbox because
      # darwin.libiconv is present there, while a Mac after GC is not. Fail
      # the build if the embedded addon references any /nix/store path.
      addonDeps="$(otool -L "packages/natives/native/${platform.addon}")"
      if grep -q "/nix/store/" <<<"$addonDeps"; then
        echo "embedded addon references /nix/store paths:" >&2
        echo "$addonDeps" >&2
        exit 1
      fi
    ''}
    runHook postInstallCheck
  '';

  meta = {
    description = "Terminal-based coding agent with multi-model support";
    homepage = "https://omp.sh";
    changelog = "https://github.com/Alex1990/oh-your-pi/releases/tag/v${packageJson.version}";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      binaryNativeCode
      fromSource
    ];
  };
}
