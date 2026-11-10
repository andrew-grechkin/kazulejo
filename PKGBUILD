# Maintainer: Andrew Grechkin <andrew.grechkin@gmail.com>
# Contributor: Andrew Grechkin <andrew.grechkin@gmail.com>

# shellcheck disable=SC2034,SC2154,SC2164

_pkgname=kazulejo
_srcname=kazulejo-git
pkgname="$_pkgname-git"
pkgver=0.8.0
pkgrel=1
pkgdesc="Class-based window rules and a configurable tiling layout for KWin"
arch=('any')
url="https://github.com/andrew-grechkin/$_pkgname"
license=('MIT')
depends=('argc' 'diffutils' 'plasma-desktop')
makedepends=('git')

# KAZULEJO_LOCAL_SOURCE=1 builds from the working tree instead of cloning
# GitHub. The default is the AUR/git mode.
if [[ -n ${KAZULEJO_LOCAL_SOURCE:-} ]]; then
    source=()
    sha256sums=()
else
    source=("$_srcname::git+$url")
    sha256sums=('SKIP')
fi

prepare() {
    if [[ -n ${KAZULEJO_LOCAL_SOURCE:-} ]]; then
        mkdir -p "$srcdir/$_srcname"
        cp -a \
            "$startdir/setup" \
            "$startdir/.fetch-argc.bash" \
            "$startdir/metadata.json" \
            "$startdir/README.md" \
            "$startdir/LICENSE" \
            "$startdir/contents" \
            "$startdir/script" \
            "$startdir/.config" \
            "$srcdir/$_srcname/"
        return
    fi

    cd "$srcdir/$_srcname"

    # Package only the latest tag, not HEAD if it is untagged.
    git fetch --tags

    local _latest_tag
    _latest_tag=$(git describe --tags --abbrev=0)

    git -c advice.detachedHead=false checkout "$_latest_tag"
}

pkgver() {
    if [[ -n ${KAZULEJO_LOCAL_SOURCE:-} ]]; then
        printf '%s\n' "$pkgver"
        return
    fi

    cd "$srcdir/$_srcname"

    git describe --tags --abbrev=0 | sed 's/^v//'
}

check() {
    cd "$srcdir/$_srcname"

    local _file
    for _file in setup .fetch-argc.bash; do
        bash -n "$_file"
    done
}

package() {
    cd "$srcdir/$_srcname"

    install -Dm755 setup "$pkgdir/usr/lib/$_pkgname/kazulejo"
    install -Dm644 .fetch-argc.bash "$pkgdir/usr/lib/$_pkgname/.fetch-argc.bash"
    install -Dm644 metadata.json "$pkgdir/usr/lib/$_pkgname/metadata.json"
    install -Dm644 README.md "$pkgdir/usr/share/doc/$_pkgname/README.md"
    install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"

    local _file
    while IFS= read -r -d '' _file; do
        install -Dm644 "$_file" "$pkgdir/usr/lib/$_pkgname/$_file"
    done < <(find contents script .config -type f -print0)

    install -d "$pkgdir/usr/bin"
    ln -s "/usr/lib/$_pkgname/kazulejo" "$pkgdir/usr/bin/$_pkgname"
}
