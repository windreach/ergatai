import React from "react"

const make = (name: string) => (props: any) => React.createElement("span", { ...props, "data-icon": name })

export const HiChevronRight = make("HiChevronRight")
export const LuGitBranch = make("LuGitBranch")
export const LuGitMerge = make("LuGitMerge")
export const LuGitPullRequest = make("LuGitPullRequest")
export const LuCircleDot = make("LuCircleDot")
export const LuSearch = make("LuSearch")
export const LuX = make("LuX")
export const LuFolder = make("LuFolder")
export const LuFolderTree = make("LuFolderTree")
export const ChevronRightIcon = make("ChevronRightIcon")
