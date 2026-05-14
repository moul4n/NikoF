declare module "react" {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useState<S>(initialState: S | (() => S)): [S, (value: S | ((previousState: S) => S)) => void];
  const React: {
    createElement: (...args: unknown[]) => unknown;
  };
  export default React;
}

declare module "react-dom/client" {
  export interface Root {
    render(children: unknown): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}

declare module "vite" {
  export function defineConfig(config: unknown): unknown;
}

declare module "@vitejs/plugin-react" {
  export default function react(): unknown;
}

declare namespace JSX {
  interface Element {}

  interface IntrinsicElements {
    [elementName: string]: unknown;
  }
}