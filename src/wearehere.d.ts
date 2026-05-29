// Ambient shim for the optional 'wearehere' dependency.
// It is dynamically imported and may not be installed; this declaration
// satisfies the typechecker without pulling in a hard dependency.
declare module 'wearehere' {
  export function assess(...args: any[]): Promise<any>;
}
