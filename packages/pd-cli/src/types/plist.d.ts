/** Local typing for the `plist` package (no bundled types in plist@3.x). */
declare module 'plist' {
  interface PlistLib {
    /** Parse a plist XML document; throws on malformed input. */
    parse(xml: string): unknown;
    build(value: unknown): string;
  }
  const plist: PlistLib;
  export = plist;
}
