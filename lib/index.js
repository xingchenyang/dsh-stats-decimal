/**
 * dsh-stats-decimal — node half.
 *
 * Pure client plugin: the empty apply exists so the package can be listed as a
 * Loader entry (and so the composed cordis.yml / plugin inventory shows it).
 * All behavior ships through exports["./client"], discovered via the
 * `dsh.client` declaration in package.json.
 */
export function apply() {}
