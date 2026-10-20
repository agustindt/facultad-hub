variable "db_password" {
  type      = string
  sensitive = true
}

variable "image_tag" {
  type        = string
  description = "Tag sha-<commit> publicado por el pipeline. El mismo en el backend y en el frontend."

  validation {
    condition     = can(regex("^sha-[0-9a-f]{40}$", var.image_tag))
    error_message = "image_tag tiene que ser sha- y los 40 caracteres del commit."
  }
}

variable "docker_host" {
  type    = string
  default = "unix:///Users/agusditomaso/.colima/default/docker.sock"
}
