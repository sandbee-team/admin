import { useRef, useState } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { label } from "../lib/api";
const EMPTY = "__sandbee_empty__";
export function Select({
  options,
  value,
  onChange,
  name,
  required,
  disabled,
  className = "",
  ...props
}) {
  const trigger = useRef(null),
    [container, setContainer] = useState(undefined);
  const items = options.map((item) =>
    typeof item === "string" ? { value: item, label: label(item) } : item,
  );
  const placeholder =
    items.find((item) => item.value === "")?.label || "Select an option";
  return (
    <Primitive.Root
      value={value ?? ""}
      name={name}
      required={required}
      disabled={disabled}
      onValueChange={(next) =>
        onChange?.({ target: { value: next === EMPTY ? "" : next, name } })
      }
      onOpenChange={(open) => {
        if (open)
          setContainer(trigger.current?.closest("dialog") || document.body);
      }}
    >
      <Primitive.Trigger
        {...props}
        ref={trigger}
        className={`select-trigger ${className}`}
      >
        <Primitive.Value placeholder={placeholder} />
        <Primitive.Icon>
          <ChevronDown size={14} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal container={container}>
        <Primitive.Content
          className="select-menu"
          position="popper"
          sideOffset={5}
          collisionPadding={12}
        >
          <Primitive.ScrollUpButton className="select-scroll">
            <ChevronUp size={14} />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-options">
            {items.map((item) => (
              <Primitive.Item
                key={item.value}
                value={item.value || EMPTY}
                className="select-option"
                disabled={item.disabled}
              >
                <Primitive.ItemText>{item.label}</Primitive.ItemText>
                <Primitive.ItemIndicator>
                  <Check size={14} />
                </Primitive.ItemIndicator>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="select-scroll">
            <ChevronDown size={14} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
