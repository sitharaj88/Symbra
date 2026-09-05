<#
.SYNOPSIS
    Sample module for extractor tests.
#>
Import-Module Az.Storage
Import-Module -Name ./lib/Helpers.psm1
. "$PSScriptRoot\Common.ps1"

function Get-User {
    <#
    .SYNOPSIS
        Looks up a user by name.
    .DESCRIPTION
        Longer description that is not the summary.
    #>
    [CmdletBinding()]
    param(
        [string]$Name,
        [Parameter(Mandatory)][Session]$Session,
        [int]$Retries = 3
    )
    $repo = New-Object UserRepo
    $repo.Find($Name)
    $other = [UserRepo]::new()
    $other.Reset()
    Format-User -User $Name
    Write-Host $env:API_TOKEN
    return $repo
}

# Formats a user for display.
function script:Format-User {
    param($User)
    return $User
}

class UserRepo : BaseRepo {
    [string]$Name
    hidden [int]$Hits

    UserRepo([string]$name) {
        $this.Name = $name
    }

    [User] Find([int]$id) {
        return $null
    }

    static [void] Reset() { }
}

enum Status {
    Active
    Inactive
}
