import React from "react";
import type { AppearanceControlState } from "../runtime/appearanceController";

interface WardrobePanelProps {
  controls: AppearanceControlState[];
  disabled: boolean;
  onChange: (id: string, value: number) => void;
  onReset: () => void;
}

interface WardrobeGroup {
  id: string;
  label: string;
  controls: AppearanceControlState[];
}

function groupControls(controls: AppearanceControlState[]): WardrobeGroup[] {
  const groups: WardrobeGroup[] = [];
  const byId = new Map<string, WardrobeGroup>();

  for (const control of controls) {
    let group = byId.get(control.groupId);
    if (!group) {
      group = { id: control.groupId, label: control.groupLabel, controls: [] };
      byId.set(control.groupId, group);
      groups.push(group);
    }
    group.controls.push(control);
  }

  return groups;
}

/**
 * Wardrobe / appearance panel. Renders the runtime-resolved appearance controls
 * for the loaded character: toggles (clothing meshes) as pressable chips and
 * sliders (body/hair morphs) as range inputs. Purely presentational — every
 * change is forwarded to the runtime via onChange/onReset.
 */
export function WardrobePanel({ controls, disabled, onChange, onReset }: WardrobePanelProps): JSX.Element | null {
  if (controls.length === 0) {
    return null;
  }

  const groups = groupControls(controls);

  return (
    <section className="avatar-stage__wardrobe" aria-label="Wardrobe and appearance controls">
      <div className="avatar-stage__wardrobe-header">
        <div>
          <p className="eyebrow">Wardrobe</p>
          <p className="avatar-stage__wardrobe-summary">Clothing, body and hair options baked into this model.</p>
        </div>
        <button
          type="button"
          className="avatar-stage__wardrobe-reset"
          disabled={disabled}
          onClick={onReset}
        >
          Reset
        </button>
      </div>

      {groups.map((group) => (
        <div key={group.id} className="avatar-stage__wardrobe-group">
          <p className="avatar-stage__wardrobe-group-title">{group.label}</p>
          <div className="avatar-stage__wardrobe-controls">
            {group.controls.map((control) =>
              control.type === "toggle" ? (
                <button
                  key={control.id}
                  type="button"
                  className={
                    control.value >= 0.5
                      ? "avatar-stage__wardrobe-toggle avatar-stage__wardrobe-toggle--on"
                      : "avatar-stage__wardrobe-toggle"
                  }
                  aria-pressed={control.value >= 0.5}
                  disabled={disabled}
                  onClick={() => onChange(control.id, control.value >= 0.5 ? 0 : 1)}
                >
                  {control.label}
                </button>
              ) : (
                <label key={control.id} className="avatar-stage__wardrobe-slider">
                  <span className="avatar-stage__wardrobe-slider-label">
                    {control.label}
                    <span className="avatar-stage__wardrobe-slider-value">{Math.round(control.value * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={control.value}
                    disabled={disabled}
                    onChange={(event: { target: { value: string } }) =>
                      onChange(control.id, Number(event.target.value))
                    }
                  />
                </label>
              )
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
