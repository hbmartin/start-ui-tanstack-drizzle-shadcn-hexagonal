declare module 'cloudflare:workers' {
  type NativeSpan = {
    end(): void;
    setAttribute(key: string, value: boolean | number | string): NativeSpan;
    setAttributes(
      attributes: Record<string, boolean | number | string | undefined>
    ): NativeSpan;
  };

  export const tracing: {
    enterSpan<T>(name: string, callback: (span: NativeSpan) => T): T;
    startActiveSpan<T>(name: string, callback: (span: NativeSpan) => T): T;
    startSpan(name: string): NativeSpan;
  };
}
