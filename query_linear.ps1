$apiKey = $env:LINEAR_API_KEY
$teamId = "5e746d13-253f-43fa-a0e5-716b4da7edcd"

$body = @{
  query = "query { issues(filter: { team: { id: { eq: `"$teamId`" } } }, first: 100) { nodes { identifier title state { name } priority description createdAt updatedAt } } }"
} | ConvertTo-Json

$headers = @{
  "Content-Type" = "application/json"
  "Authorization" = $apiKey
}

$response = Invoke-RestMethod -Uri "https://api.linear.app/graphql" -Method Post -Headers $headers -Body $body

if ($response.errors) {
  Write-Host "GraphQL errors:"
  Write-Host ($response.errors | ConvertTo-Json -Depth 10)
  exit 1
}

$issues = $response.data.issues.nodes

$keywords = @('pd-console', 'console', 'dataflow', 'event log', 'event-log', 'build script', 'build')
$specificIds = @('PRI-154', 'PRI-155', 'PRI-156')

Write-Host "`n=== 匹配的 Linear Issues ===`n"

foreach ($issue in $issues) {
  $titleLower = $issue.title.ToString().ToLower()
  $descLower = ($issue.description -or '').ToString().ToLower()
  $idUpper = $issue.identifier.ToUpper()
  
  $matchesKeyword = $false
  foreach ($kw in $keywords) {
    if ($titleLower.Contains($kw) -or $descLower.Contains($kw)) {
      $matchesKeyword = $true
      break
    }
  }
  
  $matchesSpecificId = $false
  foreach ($sid in $specificIds) {
    if ($idUpper.Contains($sid)) {
      $matchesSpecificId = $true
      break
    }
  }
  
  if ($matchesKeyword -or $matchesSpecificId) {
    Write-Host "$($issue.identifier): $($issue.title)"
    Write-Host "  状态: $($issue.state.name)"
    Write-Host "  优先级: $($issue.priority)"
    Write-Host "  创建时间: $($issue.createdAt)"
    Write-Host ""
  }
}
