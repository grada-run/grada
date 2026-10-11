# grada generated infrastructure: shared input variables.

# Sleep marker consumed by desired_count and scheduler guards. `grada
# sleep` writes `terraform/sleep.auto.tfvars` (`asleep = true`) so raw
# Terraform keeps the stack asleep; `grada wake` deletes the file before
# its restore apply. Defaults to false so un-slept plans are identical
# with or without the marker file — never set this by hand.
variable "asleep" {
  description = "True while the environment is asleep (managed by grada sleep/wake)."
  type        = bool
  default     = false
}
