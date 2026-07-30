export interface DesktopThisMacProfile {
  readonly id: "local:this-mac";
  readonly kind: "local";
  readonly name: "This Mac";
  readonly origin: string;
}

export function createDesktopThisMacProfile(connection: {
  readonly authToken: string;
  readonly baseUrl: string;
}): DesktopThisMacProfile {
  return {
    id: "local:this-mac",
    kind: "local",
    name: "This Mac",
    origin: new URL(connection.baseUrl).origin,
  };
}
