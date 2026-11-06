# Optional development helper. The generated PNGs are already included in extension/.
Add-Type -AssemblyName System.Drawing
$extensionPath = Join-Path $PSScriptRoot '..\extension'
foreach ($size in @(16, 32, 48, 128)) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $background = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#245C43'))
    $foreground = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#E6F3EA'))
    $graphics.FillEllipse($background, 0, 0, $size, $size)
    $points = @(
        [System.Drawing.PointF]::new($size * .24, $size * .3),
        [System.Drawing.PointF]::new($size * .76, $size * .3),
        [System.Drawing.PointF]::new($size * .56, $size * .53),
        [System.Drawing.PointF]::new($size * .56, $size * .72),
        [System.Drawing.PointF]::new($size * .44, $size * .79),
        [System.Drawing.PointF]::new($size * .44, $size * .53)
    )
    $graphics.FillPolygon($foreground, $points)
    $bitmap.Save((Join-Path $extensionPath "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $foreground.Dispose()
    $background.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
