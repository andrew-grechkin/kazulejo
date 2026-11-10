# Apply locally
@apply:
    ./setup --apply

# Remove build artifacts and the makepkg source checkout
@clean:
    git clean -xdff

# Build the package from the local working tree
@mkpackage:
    KAZULEJO_LOCAL_SOURCE=1 makepkg -sfc

# Build and install the package from the local working tree
@install:
    KAZULEJO_LOCAL_SOURCE=1 makepkg -sfci

# Build the package from the latest git tag
@mkpackage-git:
    env -u KAZULEJO_LOCAL_SOURCE makepkg -sfc

# Regenerate .SRCINFO from PKGBUILD
@update:
    env -u KAZULEJO_LOCAL_SOURCE makepkg --printsrcinfo > .SRCINFO
