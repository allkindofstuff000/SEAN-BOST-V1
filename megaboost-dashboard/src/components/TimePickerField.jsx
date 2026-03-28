import {
  TIME_PICKER_HOURS,
  TIME_PICKER_MINUTES,
  TIME_PICKER_PERIODS,
  buildTimePickerValue,
  getTimePickerParts
} from "../utils/timeDisplay";

export default function TimePickerField({
  label,
  value,
  onChange,
  hint = "Bangladesh time (UTC+6)",
  error = "",
  wrapperClassName = "",
  labelClassName = "",
  helperClassName = "",
  errorClassName = "",
  selectClassName = "",
  rowClassName = "",
  separatorClassName = "",
  disabled = false
}) {
  const parts = getTimePickerParts(value);

  const updatePart = (field, nextValue) => {
    onChange(
      buildTimePickerValue({
        ...parts,
        [field]: nextValue
      })
    );
  };

  return (
    <div className={wrapperClassName}>
      {label ? <label className={labelClassName}>{label}</label> : null}

      <div className={rowClassName || "time-picker-row"}>
        <select
          value={parts.hour}
          onChange={(event) => updatePart("hour", event.target.value)}
          className={selectClassName || "time-picker-select"}
          disabled={disabled}
        >
          {TIME_PICKER_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {hour}
            </option>
          ))}
        </select>

        <span className={separatorClassName || "time-picker-separator"}>:</span>

        <select
          value={parts.minute}
          onChange={(event) => updatePart("minute", event.target.value)}
          className={selectClassName || "time-picker-select"}
          disabled={disabled}
        >
          {TIME_PICKER_MINUTES.map((minute) => (
            <option key={minute} value={minute}>
              {minute}
            </option>
          ))}
        </select>

        <select
          value={parts.period}
          onChange={(event) => updatePart("period", event.target.value)}
          className={selectClassName || "time-picker-select"}
          disabled={disabled}
        >
          {TIME_PICKER_PERIODS.map((period) => (
            <option key={period} value={period}>
              {period}
            </option>
          ))}
        </select>
      </div>

      {hint ? <p className={helperClassName || "hint"}>{hint}</p> : null}
      {error ? <p className={errorClassName || "field-error"}>{error}</p> : null}
    </div>
  );
}
