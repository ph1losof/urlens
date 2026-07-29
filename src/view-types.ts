/** A reusable view over a URL string with cached component boundaries. */
export interface UrlView {
  /** Returns the original URL string. */
  toString(): string;
  /** Returns the scheme without its trailing colon. */
  scheme(): string;
  /** Returns the origin with userinfo removed. */
  origin(): string;
  /** Returns hostname and explicit port, preserving IPv6 brackets. */
  host(): string;
  /** Returns the hostname without a port or IPv6 brackets. */
  hostname(): string;
  /** Returns the explicit port, or null when absent or malformed. */
  port(): number | null;
  /** Returns "/" when an authority URL has no explicit path. */
  pathname(): string;
  /** Returns the raw query without the leading question mark. */
  query(): string;
  /** Returns the fragment without the leading hash. */
  fragment(): string;
  /** Returns the decoded value, null when absent, or "" for a bare key. */
  queryParam(key: string): string | null;
  /** Returns decoded values keyed by the requested names. */
  queryParams<const K extends readonly string[]>(
    keys: K
  ): { [P in K[number]]: string | null };
  /** Tests a key after form decoding. */
  hasQueryParam(key: string): boolean;
  /** Compares a form-decoded value without materializing it. */
  queryParamEquals(key: string, expected: string): boolean;
  /** Treats an absent authority path as "/". */
  pathnameStartsWith(prefix: string): boolean;
  /** Treats an absent authority path as "/". */
  pathnameEndsWith(suffix: string): boolean;
}
