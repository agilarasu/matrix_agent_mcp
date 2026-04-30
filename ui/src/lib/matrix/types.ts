export type ChoiceOption = { id: string; label: string };

export type ChoiceSelectorEventContent = {
  request_id: string;
  prompt: string;
  options: ChoiceOption[];
  allow_multiple?: boolean;
  created_by?: "agent" | string;
};

export type ChoiceResultEventContent = {
  request_id: string;
  selected_option_ids: string[];
  submitted_by: string;
};

export type ToolCallEventContent = {
  tool_call_id?: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  source?: "agent" | string;
};

export type TaskFormSubmitEventContent = {
  file_id: string;
  priority: string;
  assigned_to: string;
  note: string;
  confirmed: boolean;
  cancelled: boolean;
  submitted_by: string;
};

export const MATRIX_EVENT_CHOICE_SELECTOR = "com.poc.choice_selector";
export const MATRIX_EVENT_CHOICE_RESULT = "com.poc.choice_result";
export const MATRIX_EVENT_TOOL_CALL = "com.poc.tool_call";
export const MATRIX_EVENT_TASK_FORM_SUBMIT = "com.poc.task_form_submit";

