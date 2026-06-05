export type Phase7OwnerDataLocation = {
  ownerId: string;
  databasePath: string;
  status: "active" | "disabled";
};

export type Phase7OwnerDataResolver = {
  resolve(ownerId: string): Promise<Phase7OwnerDataLocation | null>;
};

export function createStaticPhase7OwnerDataResolver(
  locations: readonly Phase7OwnerDataLocation[],
): Phase7OwnerDataResolver {
  const byOwner = new Map(locations.map((location) => [location.ownerId, location]));

  return {
    async resolve(ownerId: string) {
      const location = byOwner.get(ownerId);
      if (!location || location.status !== "active") return null;
      return location;
    },
  };
}

export function assertPhase7OwnerDataLocation(
  location: Phase7OwnerDataLocation | null,
  ownerId: string,
): Phase7OwnerDataLocation {
  if (!location) {
    throw new Error(`No active Phase 7 owner data location for owner ${ownerId}`);
  }
  if (location.ownerId !== ownerId) {
    throw new Error(`Resolved Phase 7 owner data location for ${location.ownerId}, expected ${ownerId}`);
  }
  return location;
}

