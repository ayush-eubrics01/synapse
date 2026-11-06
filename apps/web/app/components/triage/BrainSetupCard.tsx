"use client";

import { Button } from "../ui/Button";
import { Actions, CardFrame, Explainer } from "./CardFrame";

/** Shown while no repository is registered. */
export function BrainSetupCard({ onRegister }: { onRegister: () => void }) {
  return (
    <CardFrame tag="PROJECTS · SETUP" tone="neutral" title="Teach Synapse about your code">
      <Explainer>
        Register a repository so Synapse can learn how it is built, read-only. Nothing is written to
        it.
      </Explainer>
      <Actions>
        <Button variant="primary" onClick={onRegister}>
          Register a repository
        </Button>
      </Actions>
    </CardFrame>
  );
}
