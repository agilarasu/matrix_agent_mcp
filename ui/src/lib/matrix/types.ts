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

export const MATRIX_EVENT_CHOICE_SELECTOR = "com.poc.choice_selector";
export const MATRIX_EVENT_CHOICE_RESULT = "com.poc.choice_result";

