# Stop on first error
$ErrorActionPreference = "Stop"

Write-Host "Reading version from package.json..."
$packageJson = Get-Content -Raw -Path "package.json" | ConvertFrom-Json
$version = $packageJson.version
$imageName = "syuink-signal"
$imageTag = "$imageName`:$version"
$outputFile = "$imageName-$version.tar"

Write-Host "Building Docker image: $imageTag"
docker build -t $imageTag .

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful."
    Write-Host "Saving image to $outputFile..."
    docker save -o $outputFile $imageTag
    
    if (Test-Path $outputFile) {
        Write-Host "Successfully created $outputFile"
        Write-Host "You can load this image on another machine using: docker load -i $outputFile"
    } else {
        Write-Error "Failed to save output file."
    }
} else {
    Write-Error "Docker build failed."
}
